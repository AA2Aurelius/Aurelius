import type { Context, Hono } from 'hono';
import { logEvent, prepareEvent, withChainRetry } from '../audit';
import { issueCertificateIfComplete } from '../certificate';
import { evidenceHashes } from '../evidence';
import { clientIp, nowIso, uuid } from '../lib';
import {
  CHECK_RESPONSE_MS, END_TOLERANCE_MS, HEARTBEAT_INTERVAL_MS, Segment,
  accrue, hlsPlaylist, pickCheckTimes, releasedEndMs, releasedThrough,
} from '../playback';
import { overLimit } from '../ratelimit';
import { serveR2Object } from '../stream';
import { AppEnv, getPrescribedVideo, isUnlocked, readJson, requireActiveLink, requirePatient } from './common';

// Server-paced playback routes, registered on the patient app (so every
// path is under /api/watch/:token and has passed loadPrescription).
// See src/playback.ts for the rules.

type Ctx = Context<AppEnv>;

// Server-detected skip attempts are logged to the audit chain up to this
// many per playback (all of them are still counted).
const MAX_LOGGED_SEEK_BLOCKS = 25;

interface Playback {
  id: string;
  prescription_id: string;
  video_id: string;
  patient_session_id: string;
  created_at: string;
  total_ms: number;
  segment_count: number;
  allowed_ms: number;
  released_through: number;
  last_heartbeat_seq: number;
  last_heartbeat_at: string | null;
  last_position_ms: number;
  last_playing: number;
  last_visible: number;
  credited_ms: number;
  playing_ms: number;
  hidden_ms: number;
  pauses: number;
  seek_blocked: number;
  completed_at: string | null;
}

interface Check {
  id: string;
  at_ms: number;
  issued_at: string | null;
  expires_at: string | null;
  answered_at: string | null;
  outcome: string | null;
}

async function segmentsFor(c: Ctx, videoId: string): Promise<Segment[]> {
  const { results } = await c.env.DB.prepare(`SELECT idx, start_ms, duration_ms FROM video_segments WHERE video_id = ? ORDER BY idx`)
    .bind(videoId).all<Segment>();
  return results;
}

async function loadPlayback(c: Ctx): Promise<Playback | null> {
  return c.env.DB.prepare(`SELECT * FROM playback_sessions WHERE id = ? AND prescription_id = ?`)
    .bind(c.req.param('playbackId'), c.get('prescription').id).first<Playback>();
}

// The check currently gating playback: the earliest one not yet passed.
async function openCheck(c: Ctx, playbackId: string): Promise<Check | null> {
  return c.env.DB.prepare(`SELECT * FROM attention_checks WHERE playback_id = ? AND outcome IS NULL ORDER BY at_ms, issued_at IS NULL LIMIT 1`)
    .bind(playbackId).first<Check>();
}

function checkForClient(check: Check | null) {
  return check?.issued_at ? { id: check.id, prompt: 'Are you still watching?', expiresAt: check.expires_at } : null;
}

function state(pb: Playback, check: Check | null) {
  return {
    playbackId: pb.id,
    totalMs: pb.total_ms,
    allowedMs: pb.allowed_ms,
    releasedThrough: pb.released_through,
    nextSeq: pb.last_heartbeat_seq + 1,
    completed: !!pb.completed_at,
    attentionCheck: checkForClient(check),
  };
}

// An issued check that ran out of time is recorded as missed and replaced
// by a fresh one at the same point, so playback stays blocked until answered.
async function expireCheck(c: Ctx, pb: Playback, check: Check): Promise<Check> {
  const now = nowIso();
  const replacement: Check = {
    id: uuid(), at_ms: check.at_ms, issued_at: now,
    expires_at: new Date(Date.now() + CHECK_RESPONSE_MS).toISOString(), answered_at: null, outcome: null,
  };
  await withChainRetry(
    () => prepareEvent(
      c.env,
      { prescriptionId: pb.prescription_id, videoId: pb.video_id, type: 'attention_check_missed', ip: clientIp(c.req.raw), meta: { playback: pb.id, check: check.id, at_ms: check.at_ms, issued_at: check.issued_at } },
      { onlyIfPreviousChanged: true }
    ),
    async (ev) => {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE attention_checks SET outcome = 'missed' WHERE id = ? AND outcome IS NULL`).bind(check.id),
        ev.stmt,
        // Only if this request is the one that marked it missed (the event
        // insert just before ran only in that case).
        c.env.DB.prepare(
          `INSERT INTO attention_checks (id, playback_id, at_ms, issued_at, expires_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1`
        ).bind(replacement.id, pb.id, replacement.at_ms, replacement.issued_at, replacement.expires_at),
      ]);
    }
  );
  return (await openCheck(c, pb.id)) ?? replacement;
}

async function logSeekBlocked(c: Ctx, pb: Playback, meta: Record<string, unknown>) {
  const counted = await c.env.DB.prepare(`UPDATE playback_sessions SET seek_blocked = seek_blocked + 1 WHERE id = ? RETURNING seek_blocked`)
    .bind(pb.id).first<{ seek_blocked: number }>();
  if ((counted?.seek_blocked ?? 0) <= MAX_LOGGED_SEEK_BLOCKS) {
    await logEvent(c.env, { prescriptionId: pb.prescription_id, videoId: pb.video_id, type: 'seek_blocked', ip: clientIp(c.req.raw), meta: { playback: pb.id, source: 'server', ...meta } });
  }
}

// Server-side completion: records the playback's evidence summary and the
// video's completion in one transaction, then issues the certificate if
// this was the last video.
async function completePlayback(c: Ctx, pb: Playback): Promise<void> {
  const evidence = await evidenceHashes(c.env, pb.id);
  const checks = await c.env.DB.prepare(
    `SELECT SUM(outcome = 'passed') AS passed, SUM(outcome = 'missed') AS missed FROM attention_checks WHERE playback_id = ?`
  ).bind(pb.id).first<{ passed: number | null; missed: number | null }>();
  const completedAt = nowIso();
  const ip = clientIp(c.req.raw);
  const summary = {
    playback: pb.id,
    started_at: pb.created_at,
    total_ms: pb.total_ms,
    credited_ms: pb.credited_ms,
    playing_ms: pb.playing_ms,
    hidden_ms: pb.hidden_ms,
    pauses: pb.pauses,
    seek_blocked: pb.seek_blocked,
    attention_checks_passed: checks?.passed ?? 0,
    attention_checks_missed: checks?.missed ?? 0,
    ...evidence,
  };

  await withChainRetry(
    async () => {
      const first = await prepareEvent(c.env, { prescriptionId: pb.prescription_id, videoId: pb.video_id, type: 'playback_completed', ip, meta: summary }, { onlyIfPreviousChanged: true });
      const second = await prepareEvent(
        c.env,
        { prescriptionId: pb.prescription_id, videoId: pb.video_id, type: 'complete', ip, meta: { verification_level: 'server-paced-v1', playback: pb.id } },
        { head: { seq: first.row.seq, hash: first.hash }, onlyIfPreviousChanged: true }
      );
      return [first, second] as const;
    },
    async ([first, second]) => {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE playback_sessions SET completed_at = ? WHERE id = ? AND completed_at IS NULL`).bind(completedAt, pb.id),
        first.stmt,
        // A rewatch of an already-complete video changes nothing here, and
        // the "complete" event is then skipped.
        c.env.DB.prepare(
          `UPDATE video_progress SET completed_at = ?, completed_playback_id = ? WHERE prescription_id = ? AND video_id = ? AND completed_at IS NULL`
        ).bind(completedAt, pb.id, pb.prescription_id, pb.video_id),
        second.stmt,
      ]);
    }
  );

  try {
    await issueCertificateIfComplete(c.env, pb.prescription_id);
  } catch (err) {
    // Completion stands; issuance is retried on the next certificate request.
    console.error('certificate issuance failed', err);
  }
}

function isComplete(pb: Playback, servedCount: number, check: Check | null): boolean {
  return pb.allowed_ms >= pb.total_ms && servedCount >= pb.segment_count && !check && pb.last_position_ms >= pb.total_ms - END_TOLERANCE_MS;
}

export function registerPlaybackRoutes(app: Hono<AppEnv>) {
  // Start watching a video, or resume the unfinished playback of it.
  app.post('/:token/video/:videoId/playback', requireActiveLink, requirePatient, async (c) => {
    const p = c.get('prescription');
    const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
    if (!video) return c.json({ error: 'Not found.' }, 404);
    if (!(await isUnlocked(c.env, p.id, video.order_index))) {
      return c.json({ error: 'This video is locked until the previous one is finished.' }, 403);
    }
    const packaged = await c.env.DB.prepare(`SELECT hls_init_r2_key FROM videos WHERE id = ?`).bind(video.video_id).first<{ hls_init_r2_key: string | null }>();
    const segments = await segmentsFor(c, video.video_id);
    if (!packaged?.hls_init_r2_key || segments.length === 0) return c.json({ error: 'This video is not available yet.' }, 409);

    const existing = await c.env.DB.prepare(
      `SELECT * FROM playback_sessions WHERE prescription_id = ? AND video_id = ? AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(p.id, video.video_id).first<Playback>();
    if (existing) {
      return c.json({ ...state(existing, await openCheck(c, existing.id)), resumed: true, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, playlist: `playback/${existing.id}/playlist.m3u8` });
    }

    const last = segments[segments.length - 1];
    const totalMs = last.start_ms + last.duration_ms;
    const pb: Playback = {
      id: uuid(), prescription_id: p.id, video_id: video.video_id, patient_session_id: c.get('patient').sessionId,
      created_at: nowIso(), total_ms: totalMs, segment_count: segments.length, allowed_ms: 0,
      released_through: releasedThrough(segments, 0), last_heartbeat_seq: 0, last_heartbeat_at: null, last_position_ms: 0,
      last_playing: 0, last_visible: 1, credited_ms: 0, playing_ms: 0, hidden_ms: 0, pauses: 0, seek_blocked: 0, completed_at: null,
    };
    const checkTimes = pickCheckTimes(totalMs);
    await withChainRetry(
      () => prepareEvent(c.env, {
        prescriptionId: p.id, videoId: video.video_id, type: 'playback_started', ip: clientIp(c.req.raw),
        // Check times are deliberately not logged until they happen.
        meta: { playback: pb.id, session: pb.patient_session_id.slice(0, 16), segments: segments.length, total_ms: totalMs, attention_checks: checkTimes.length },
      }),
      async (ev) => {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO playback_sessions (id, prescription_id, video_id, patient_session_id, created_at, total_ms, segment_count, released_through)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(pb.id, pb.prescription_id, pb.video_id, pb.patient_session_id, pb.created_at, pb.total_ms, pb.segment_count, pb.released_through),
          ...checkTimes.map((at) => c.env.DB.prepare(`INSERT INTO attention_checks (id, playback_id, at_ms) VALUES (?, ?, ?)`).bind(uuid(), pb.id, at)),
          ev.stmt,
        ]);
      }
    );
    return c.json({ ...state(pb, null), resumed: false, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, playlist: `playback/${pb.id}/playlist.m3u8` }, 201);
  });

  app.get('/:token/playback/:playbackId', requirePatient, async (c) => {
    const pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    return c.json(state(pb, await openCheck(c, pb.id)));
  });

  // The live (EVENT) playlist: only released chunks are listed.
  app.get('/:token/playback/:playbackId/playlist.m3u8', requireActiveLink, requirePatient, async (c) => {
    const pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    const segments = await segmentsFor(c, pb.video_id);
    const body = hlsPlaylist(segments, pb.released_through, pb.released_through >= segments.length - 1);
    return new Response(body, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-store' } });
  });

  app.get('/:token/playback/:playbackId/init.mp4', requireActiveLink, requirePatient, async (c) => {
    const pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    const video = await c.env.DB.prepare(`SELECT hls_init_r2_key FROM videos WHERE id = ?`).bind(pb.video_id).first<{ hls_init_r2_key: string }>();
    const res = video && (await serveR2Object(c.env.VIDEOS, video.hls_init_r2_key, c.req.raw));
    return res || c.json({ error: 'Not found.' }, 404);
  });

  // A media chunk. Refused (and logged) if it hasn't been released yet.
  app.get('/:token/playback/:playbackId/seg/:file', requireActiveLink, requirePatient, async (c) => {
    const pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    const m = /^(\d{1,6})\.m4s$/.exec(c.req.param('file'));
    const idx = m ? Number(m[1]) : -1;
    if (idx < 0 || idx >= pb.segment_count) return c.json({ error: 'Not found.' }, 404);
    if (idx > pb.released_through) {
      if (await overLimit(c.env, `segblock:${pb.id}`, 60, 60)) return c.json({ error: 'Too many requests.' }, 429);
      await logSeekBlocked(c, pb, { reason: 'unreleased_segment', idx, released_through: pb.released_through });
      return c.json({ error: 'This part of the video is not available yet.' }, 403);
    }

    const seg = await c.env.DB.prepare(`SELECT r2_key FROM video_segments WHERE video_id = ? AND idx = ?`).bind(pb.video_id, idx).first<{ r2_key: string }>();
    const res = seg && (await serveR2Object(c.env.VIDEOS, seg.r2_key, c.req.raw));
    if (!res) return c.json({ error: 'Not found.' }, 404);
    if (c.req.raw.method === 'GET' && res.ok) {
      await c.env.DB.prepare(`INSERT OR IGNORE INTO segment_serves (playback_id, idx, first_served_at) VALUES (?, ?, ?)`).bind(pb.id, idx, nowIso()).run();
    }
    return res;
  });

  // Heartbeat every ~5 s. This is the only thing that advances playback.
  app.post('/:token/playback/:playbackId/heartbeat', requireActiveLink, requirePatient, async (c) => {
    let pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    if (pb.completed_at) return c.json(state(pb, null));
    if (await overLimit(c.env, `hb:${pb.id}`, 40, 60)) return c.json({ error: 'Too many heartbeats.' }, 429);

    const body = await readJson(c);
    const seq = body.seq;
    const position = body.position_ms;
    const playing = body.playing;
    const visible = body.visible;
    const rate = body.rate ?? 1;
    if (!Number.isInteger(seq) || !Number.isInteger(position) || (position as number) < 0 || typeof playing !== 'boolean' || typeof visible !== 'boolean' || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 16) {
      return c.json({ error: 'Invalid heartbeat.' }, 400);
    }
    if (seq !== pb.last_heartbeat_seq + 1) return c.json({ error: 'Out-of-order heartbeat.', expectedSeq: pb.last_heartbeat_seq + 1 }, 409);

    const segments = await segmentsFor(c, pb.video_id);
    const now = nowIso();
    const nowMs = Date.parse(now);

    let check = await openCheck(c, pb.id);
    if (check?.issued_at && !check.answered_at && check.expires_at! <= now) check = await expireCheck(c, pb, check);

    const acc = accrue(
      { allowed_ms: pb.allowed_ms, total_ms: pb.total_ms, last_heartbeat_at: pb.last_heartbeat_at, last_playing: !!pb.last_playing, last_visible: !!pb.last_visible },
      position as number, nowMs, check ? check.at_ms : null
    );
    const through = Math.max(pb.released_through, releasedThrough(segments, acc.allowed_ms));
    const paused = !!pb.last_playing && !playing;

    // The player claims a position past anything it has been sent.
    const positionAhead = (position as number) > releasedEndMs(segments, pb.released_through) + 1000;

    const writes = [
      // The primary key on (playback_id, seq) rejects a duplicate or racing heartbeat.
      c.env.DB.prepare(`INSERT INTO heartbeats (playback_id, seq, received_at, position_ms, playing, visible, rate) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(pb.id, seq, now, position, playing ? 1 : 0, visible ? 1 : 0, rate),
      c.env.DB.prepare(
        `UPDATE playback_sessions SET allowed_ms = ?, released_through = ?, last_heartbeat_seq = ?, last_heartbeat_at = ?, last_position_ms = ?,
           last_playing = ?, last_visible = ?, credited_ms = credited_ms + ?, playing_ms = playing_ms + ?, hidden_ms = hidden_ms + ?,
           pauses = pauses + ? WHERE id = ? AND last_heartbeat_seq = ?`
      ).bind(acc.allowed_ms, through, seq, now, position, playing ? 1 : 0, visible ? 1 : 0, acc.credited_ms, acc.playing_ms, acc.hidden_ms, paused ? 1 : 0, pb.id, seq - 1),
    ];
    if (paused) {
      writes.push(c.env.DB.prepare(`UPDATE video_progress SET pause_count = pause_count + 1 WHERE prescription_id = ? AND video_id = ?`).bind(pb.prescription_id, pb.video_id));
    }
    try {
      await c.env.DB.batch(writes);
    } catch (err) {
      if (/UNIQUE constraint failed: heartbeats/.test(String((err as any)?.message ?? err))) {
        return c.json({ error: 'Out-of-order heartbeat.', expectedSeq: seq + 1 }, 409);
      }
      throw err;
    }
    if (positionAhead) await logSeekBlocked(c, pb, { reason: 'position_ahead', position_ms: position, released_end_ms: releasedEndMs(segments, pb.released_through) });

    pb = (await loadPlayback(c))!;

    // Playback has reached a check: show it now, with its response window.
    if (check && !check.issued_at && pb.allowed_ms >= check.at_ms) {
      const issuedAt = nowIso();
      const expiresAt = new Date(Date.now() + CHECK_RESPONSE_MS).toISOString();
      await c.env.DB.prepare(`UPDATE attention_checks SET issued_at = ?, expires_at = ? WHERE id = ? AND issued_at IS NULL`).bind(issuedAt, expiresAt, check.id).run();
      check = { ...check, issued_at: issuedAt, expires_at: expiresAt };
    }

    if (!check) {
      const served = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM segment_serves WHERE playback_id = ?`).bind(pb.id).first<{ n: number }>();
      if (isComplete(pb, served?.n ?? 0, null)) {
        await completePlayback(c, pb);
        pb = (await loadPlayback(c))!;
      }
    }
    return c.json(state(pb, check && pb.allowed_ms >= check.at_ms ? check : null));
  });

  // Answer the "Are you still watching?" check.
  app.post('/:token/playback/:playbackId/attention', requireActiveLink, requirePatient, async (c) => {
    const pb = await loadPlayback(c);
    if (!pb) return c.json({ error: 'Not found.' }, 404);
    const body = await readJson(c);
    const check = await openCheck(c, pb.id);
    if (!check || !check.issued_at || check.id !== body.checkId) return c.json({ error: 'No such attention check.' }, 404);

    const now = nowIso();
    if (check.expires_at! <= now) {
      const next = await expireCheck(c, pb, check);
      return c.json({ error: 'That check timed out.', attentionCheck: checkForClient(next) }, 409);
    }
    const responseMs = Date.parse(now) - Date.parse(check.issued_at);
    await withChainRetry(
      () => prepareEvent(
        c.env,
        { prescriptionId: pb.prescription_id, videoId: pb.video_id, type: 'attention_check_passed', ip: clientIp(c.req.raw), meta: { playback: pb.id, check: check.id, at_ms: check.at_ms, response_ms: responseMs } },
        { onlyIfPreviousChanged: true }
      ),
      async (ev) => {
        await c.env.DB.batch([
          c.env.DB.prepare(`UPDATE attention_checks SET outcome = 'passed', answered_at = ? WHERE id = ? AND outcome IS NULL`).bind(now, check.id),
          ev.stmt,
        ]);
      }
    );
    const after = (await loadPlayback(c))!;
    return c.json(state(after, await openCheck(c, pb.id).then((n) => (n && after.allowed_ms >= n.at_ms ? n : null))));
  });
}
