import { describe, expect, it } from 'vitest';
import { accrue, pickCheckTimes, releasedThrough } from '../src/playback';
import { Client, INIT_BYTES, advance, env, events, playVideo, prescribe, segmentBytes, seedProcedure, verifiedPatient } from './helpers';

async function start(client: Client, token: string, videoId: string) {
  const res = await client.post(`/api/watch/${token}/video/${videoId}/playback`);
  const body = (await res.json()) as any;
  return { res, body, base: `/api/watch/${token}/playback/${body.playbackId}` };
}

async function heartbeat(client: Client, base: string, seq: number, hb: { position_ms: number; playing?: boolean; visible?: boolean }) {
  const res = await client.post(`${base}/heartbeat`, { seq, playing: true, visible: true, rate: 1, ...hb });
  return { res, body: (await res.json()) as any };
}

async function playbackRow(id: string) {
  return env.DB.prepare(`SELECT * FROM playback_sessions WHERE id = ?`).bind(id).first<any>();
}

async function progress(prescriptionId: string, videoId: string) {
  return env.DB.prepare(`SELECT * FROM video_progress WHERE prescription_id = ? AND video_id = ?`).bind(prescriptionId, videoId).first<any>();
}

// A single-video prescription with its attention checks removed, for tests
// that aren't about checks.
async function setupNoChecks(duration = 60) {
  const s = await prescribe({ videos: 1, duration });
  const p = await verifiedPatient(s.token, s.patientEmail);
  const { body, base } = await start(p, s.token, s.videoIds[0]);
  await env.DB.prepare(`DELETE FROM attention_checks WHERE playback_id = ?`).bind(body.playbackId).run();
  return { ...s, p, playbackId: body.playbackId as string, base };
}

describe('pacing rules (unit)', () => {
  const state = { allowed_ms: 10_000, total_ms: 60_000, last_heartbeat_at: new Date(0).toISOString(), last_playing: true, last_visible: true };

  it('credits real time only while playing and visible', () => {
    expect(accrue(state, 60_000, 5_000, null).allowed_ms).toBe(15_000);
    expect(accrue({ ...state, last_playing: false }, 60_000, 5_000, null).allowed_ms).toBe(10_000);
    const hidden = accrue({ ...state, last_visible: false }, 60_000, 5_000, null);
    expect(hidden.allowed_ms).toBe(10_000);
    expect(hidden.hidden_ms).toBe(5_000);
  });

  it('caps a long gap, a stalled player, a pending check and the end', () => {
    expect(accrue(state, 60_000, 600_000, null).allowed_ms).toBe(25_000);       // 15 s max per gap
    expect(accrue(state, 11_000, 5_000, null).allowed_ms).toBe(15_000);         // position 11 s + 4 s tolerance
    expect(accrue(state, 60_000, 5_000, 12_000).allowed_ms).toBe(12_000);       // check at 12 s
    expect(accrue({ ...state, allowed_ms: 58_000 }, 60_000, 5_000, null).allowed_ms).toBe(60_000);
    expect(accrue(state, 0, 5_000, null).allowed_ms).toBe(10_000);             // never goes backwards
  });

  it('releases 12 s ahead and places checks inside 10%-90%', () => {
    const segs = Array.from({ length: 15 }, (_, i) => ({ idx: i, start_ms: i * 4000, duration_ms: 4000 }));
    expect(releasedThrough(segs, 0)).toBe(2);
    expect(releasedThrough(segs, 4000)).toBe(3);
    expect(releasedThrough(segs, 60_000)).toBe(14);
    for (let i = 0; i < 50; i++) {
      for (const t of pickCheckTimes(300_000)) expect(t >= 30_000 && t <= 270_000).toBe(true);
      const [a, b] = pickCheckTimes(300_000);
      expect(a).toBeLessThanOrEqual(150_000);
      expect(b).toBeGreaterThanOrEqual(150_000);
    }
    expect(pickCheckTimes(40_000)).toHaveLength(1);
  });
});

describe('starting playback', () => {
  it('requires a verified session, an unlocked video in this prescription, and a packaged video', async () => {
    const s = await prescribe();
    const other = await prescribe();
    expect((await new Client().post(`/api/watch/${s.token}/video/${s.videoIds[0]}/playback`)).status).toBe(401);
    const p = await verifiedPatient(s.token, s.patientEmail);
    expect((await start(p, s.token, s.videoIds[1])).res.status).toBe(403);
    expect((await start(p, s.token, other.videoIds[0])).res.status).toBe(404);

    await env.DB.prepare(`UPDATE videos SET hls_init_r2_key = NULL WHERE id = ?`).bind(s.videoIds[0]).run();
    expect((await start(p, s.token, s.videoIds[0])).res.status).toBe(409);
  });

  it('resumes the unfinished playback instead of starting over', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0 });
    advance(5000);
    await heartbeat(s.p, s.base, 2, { position_ms: 5000 });
    const again = await start(s.p, s.token, s.videoIds[0]);
    expect(again.res.status).toBe(200);
    expect(again.body).toMatchObject({ playbackId: s.playbackId, resumed: true, nextSeq: 3, allowedMs: 5000 });
  });
});

describe('the playlist and chunks', () => {
  it('lists only released chunks as a live EVENT playlist', async () => {
    const s = await setupNoChecks();
    const res = await s.p.fetch(`${s.base}/playlist.m3u8`);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    const text = await res.text();
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(text).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(text.match(/seg\/\d+\.m4s/g)).toEqual(['seg/0.m4s', 'seg/1.m4s', 'seg/2.m4s']);
    expect(text).not.toContain('#EXT-X-ENDLIST');
  });

  it('serves released chunks (with Range support) and records the first serve', async () => {
    const s = await setupNoChecks();
    const init = await s.p.fetch(`${s.base}/init.mp4`);
    expect(new Uint8Array(await init.arrayBuffer())).toEqual(INIT_BYTES);
    const seg = await s.p.fetch(`${s.base}/seg/1.m4s`);
    expect(seg.status).toBe(200);
    expect(new Uint8Array(await seg.arrayBuffer())).toEqual(segmentBytes(1));
    const part = await s.p.fetch(`${s.base}/seg/1.m4s`, { headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(segmentBytes(1).slice(10, 20));
    const serves = await env.DB.prepare(`SELECT idx FROM segment_serves WHERE playback_id = ?`).bind(s.playbackId).all<any>();
    expect(serves.results.map((r) => r.idx)).toEqual([1]);
  });

  it('refuses and logs a request for a chunk that is not released yet', async () => {
    const s = await setupNoChecks();
    for (const idx of [3, 14]) {
      const res = await s.p.fetch(`${s.base}/seg/${idx}.m4s`);
      expect(res.status).toBe(403);
      await res.arrayBuffer();
    }
    expect((await s.p.fetch(`${s.base}/seg/99.m4s`)).status).toBe(404);
    expect((await playbackRow(s.playbackId)).seek_blocked).toBe(2);
    const blocked = (await events(s.prescriptionId)).filter((e) => e.event_type === 'seek_blocked');
    expect(blocked.map((e) => JSON.parse(e.meta))).toMatchObject([
      { source: 'server', reason: 'unreleased_segment', idx: 3 },
      { source: 'server', reason: 'unreleased_segment', idx: 14 },
    ]);
  });

  it("can't be read by another prescription's patient", async () => {
    const s = await setupNoChecks();
    const other = await prescribe();
    const stranger = await verifiedPatient(other.token, other.patientEmail);
    expect((await stranger.fetch(`/api/watch/${other.token}/playback/${s.playbackId}/seg/0.m4s`)).status).toBe(404);
    expect((await stranger.fetch(`/api/watch/${s.token}/playback/${s.playbackId}/seg/0.m4s`)).status).toBe(401);
  });
});

describe('attempts to go faster than real time', () => {
  it('rapid heartbeats claiming the end earn nothing without time passing', async () => {
    const s = await setupNoChecks();
    for (let seq = 1; seq <= 20; seq++) await heartbeat(s.p, s.base, seq, { position_ms: 60_000 });
    const row = await playbackRow(s.playbackId);
    expect(row.allowed_ms).toBe(0);
    expect(row.released_through).toBe(2);
    expect(row.completed_at).toBeNull();
  });

  it('claiming the end every 5 s still only advances 5 s at a time, and is logged', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0 });
    for (let seq = 2; seq <= 4; seq++) {
      advance(5000);
      await heartbeat(s.p, s.base, seq, { position_ms: 60_000 });
    }
    expect((await playbackRow(s.playbackId)).allowed_ms).toBe(15_000);
    const reasons = (await events(s.prescriptionId)).filter((e) => e.event_type === 'seek_blocked').map((e) => JSON.parse(e.meta).reason);
    expect(reasons).toContain('position_ahead');
  });

  it("paused time can't be banked", async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0, playing: false });
    advance(10 * 60_000);
    await heartbeat(s.p, s.base, 2, { position_ms: 0, playing: true });
    expect((await playbackRow(s.playbackId)).allowed_ms).toBe(0);
    advance(5000);
    await heartbeat(s.p, s.base, 3, { position_ms: 5000 });
    expect((await playbackRow(s.playbackId)).allowed_ms).toBe(5000);
  });

  it('a long silence while "playing" earns at most 15 s', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0 });
    advance(10 * 60_000);
    await heartbeat(s.p, s.base, 2, { position_ms: 60_000 });
    expect((await playbackRow(s.playbackId)).allowed_ms).toBe(15_000);
  });

  it('a hidden tab earns nothing, and hidden time is recorded', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0, visible: false });
    advance(5000);
    await heartbeat(s.p, s.base, 2, { position_ms: 5000, visible: false });
    const row = await playbackRow(s.playbackId);
    expect(row.allowed_ms).toBe(0);
    expect(row.hidden_ms).toBe(5000);
  });

  it('rejects duplicate, skipped and malformed heartbeats', async () => {
    const s = await setupNoChecks();
    expect((await heartbeat(s.p, s.base, 1, { position_ms: 0 })).res.status).toBe(200);
    expect((await heartbeat(s.p, s.base, 1, { position_ms: 0 })).res.status).toBe(409);
    expect((await heartbeat(s.p, s.base, 5, { position_ms: 0 })).res.status).toBe(409);
    expect((await s.p.post(`${s.base}/heartbeat`, { seq: 2, position_ms: -1, playing: true, visible: true })).status).toBe(400);
    expect((await s.p.post(`${s.base}/heartbeat`, { seq: 2, position_ms: 'x', playing: true, visible: true })).status).toBe(400);
  });

  it('racing heartbeats with the same seq: exactly one is accepted', async () => {
    const s = await setupNoChecks();
    const results = await Promise.all([1, 2, 3].map(() => s.p.post(`${s.base}/heartbeat`, { seq: 1, position_ms: 0, playing: true, visible: true })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM heartbeats WHERE playback_id = ?`).bind(s.playbackId).first<any>();
    expect(n.n).toBe(1);
  });
});

describe('completion', () => {
  it('an honest player completes after real time equal to the video length', async () => {
    const s = await prescribe({ videos: 1, duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const began = Date.now();
    const { state, playbackId, checksAnswered } = await playVideo(p, s.token, s.videoIds[0]);
    expect(state.completed).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(60_000);
    expect(checksAnswered).toBe(2); // a 60 s video gets one check in each half

    const row = await progress(s.prescriptionId, s.videoIds[0]);
    expect(row.completed_at).not.toBeNull();
    expect(row.completed_playback_id).toBe(playbackId);

    const types = (await events(s.prescriptionId)).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['playback_started', 'attention_check_passed', 'playback_completed', 'complete', 'certificate_issued']));
    const done = (await events(s.prescriptionId)).find((e) => e.event_type === 'playback_completed');
    expect(JSON.parse(done.meta)).toMatchObject({ playback: playbackId, segments_served: 15, attention_checks_passed: 2, attention_checks_missed: 0 });
    expect(JSON.parse(done.meta).credited_ms).toBe(60_000);
  });

  it("isn't complete until every chunk has actually been served", async () => {
    const s = await setupNoChecks();
    let seq = 1;
    let position = 0;
    let st: any;
    for (let i = 0; i < 20; i++) {
      st = (await heartbeat(s.p, s.base, seq++, { position_ms: position })).body;
      advance(5000);
      position = Math.min(position + 5000, 60_000);
    }
    expect(st.allowedMs).toBe(60_000);
    expect(st.completed).toBe(false);
    for (let i = 0; i < 15; i++) await (await s.p.fetch(`${s.base}/seg/${i}.m4s`)).arrayBuffer();
    st = (await heartbeat(s.p, s.base, seq++, { position_ms: 60_000 })).body;
    expect(st.completed).toBe(true);
  });

  it('unlocks the next video only after the previous one is complete', async () => {
    const s = await prescribe({ videos: 2 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    expect((await start(p, s.token, s.videoIds[1])).res.status).toBe(403);
    await playVideo(p, s.token, s.videoIds[0]);
    expect((await start(p, s.token, s.videoIds[1])).res.status).toBe(201);
  });

  it('a rewatch after completion records a new playback but no second completion', async () => {
    const s = await prescribe({ videos: 1 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const first = await playVideo(p, s.token, s.videoIds[0]);
    const second = await playVideo(p, s.token, s.videoIds[0]);
    expect(second.playbackId).not.toBe(first.playbackId);
    expect(second.state.completed).toBe(true);
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'complete')).toHaveLength(1);
    expect((await progress(s.prescriptionId, s.videoIds[0])).completed_playback_id).toBe(first.playbackId);
  });

  it('counts pauses from the heartbeats', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0 });
    await heartbeat(s.p, s.base, 2, { position_ms: 0, playing: false });
    await heartbeat(s.p, s.base, 3, { position_ms: 0, playing: true });
    await heartbeat(s.p, s.base, 4, { position_ms: 0, playing: false });
    expect((await playbackRow(s.playbackId)).pauses).toBe(2);
    expect((await progress(s.prescriptionId, s.videoIds[0])).pause_count).toBe(2);
  });
});

describe('attention checks', () => {
  it('stop playback at a moment the client is never told in advance', async () => {
    const s = await prescribe({ videos: 1, duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const { body } = await start(p, s.token, s.videoIds[0]);
    expect(JSON.stringify(body)).not.toMatch(/at_ms|atMs/);
    const state = (await (await p.fetch(`/api/watch/${s.token}/playback/${body.playbackId}`)).json()) as any;
    expect(state.attentionCheck).toBeNull();
  });

  it('block progress until answered; a missed one is logged and re-asked', async () => {
    const s = await prescribe({ videos: 1, duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const run = await playVideo(p, s.token, s.videoIds[0], { answerChecks: false, maxTicks: 30 });
    expect(run.state.completed).toBe(false);
    expect(run.state.attentionCheck).toMatchObject({ prompt: 'Are you still watching?' });
    const check = await env.DB.prepare(`SELECT * FROM attention_checks WHERE playback_id = ? ORDER BY at_ms LIMIT 1`).bind(run.playbackId).first<any>();
    expect((await playbackRow(run.playbackId)).allowed_ms).toBe(check.at_ms);

    // 30 ticks x 5 s is well past the 60 s window: the first check was missed and replaced.
    const missed = (await events(s.prescriptionId)).filter((e) => e.event_type === 'attention_check_missed');
    expect(missed.length).toBeGreaterThanOrEqual(1);

    // Ask for the currently open check (the last one shown may have just timed out), then answer it in time.
    const fresh = (await heartbeat(p, run.base, run.seq, { position_ms: 0, playing: false })).body;
    expect(fresh.attentionCheck).toBeTruthy();
    const answer = await p.post(`${run.base}/attention`, { checkId: fresh.attentionCheck.id });
    expect(answer.status).toBe(200);
    const done = await playVideo(p, s.token, s.videoIds[0]);
    expect(done.playbackId).toBe(run.playbackId);
    expect(done.state.completed).toBe(true);

    const cert = (await (await p.fetch(`/api/watch/${s.token}/certificate`)).json()) as any;
    expect(cert.certificate.videos[0].watch.attention_checks_passed).toBe(2);
    expect(cert.certificate.videos[0].watch.attention_checks_missed).toBeGreaterThanOrEqual(1);
  });

  it('a late answer does not count', async () => {
    const s = await prescribe({ videos: 1, duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const run = await playVideo(p, s.token, s.videoIds[0], { answerChecks: false, maxTicks: 12 });
    const id = run.state.attentionCheck?.id;
    expect(id).toBeTruthy();
    advance(61_000);
    const late = await p.post(`${run.base}/attention`, { checkId: id });
    expect(late.status).toBe(409);
    const body = (await late.json()) as any;
    expect(body.attentionCheck.id).not.toBe(id);
    expect((await p.post(`${run.base}/attention`, { checkId: 'made-up' })).status).toBe(404);
  });
});

describe('evidence', () => {
  it('chunk-serve and heartbeat records are append-only', async () => {
    const s = await setupNoChecks();
    await heartbeat(s.p, s.base, 1, { position_ms: 0 });
    await (await s.p.fetch(`${s.base}/seg/0.m4s`)).arrayBuffer();
    await expect(env.DB.prepare(`UPDATE heartbeats SET position_ms = 1`).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare(`DELETE FROM segment_serves`).run()).rejects.toThrow(/append-only/);
  });

  it('packaged-video fixtures are sane', async () => {
    const { videoIds } = await seedProcedure(1, 10);
    const segs = await env.DB.prepare(`SELECT start_ms, duration_ms FROM video_segments WHERE video_id = ? ORDER BY idx`).bind(videoIds[0]).all<any>();
    expect(segs.results).toEqual([{ start_ms: 0, duration_ms: 4000 }, { start_ms: 4000, duration_ms: 4000 }, { start_ms: 8000, duration_ms: 2000 }]);
  });
});
