import { Hono } from 'hono';
import { logEvent, prepareEvent, withChainRetry } from '../audit';
import { VERIFICATION_LEVEL, formatVerificationCode, getCertificateRow, issueCertificateIfComplete } from '../certificate';
import { sendEmail } from '../email';
import { clientIp, hmacHex, hoursUntil, maskEmail, nowIso, randomBytes, secondsFromNow, secondsSince, timingSafeEqual, uuid } from '../lib';
import { overLimit } from '../ratelimit';
import { createPatientSession, getPatientSession } from '../sessions';
import { serveR2Object } from '../stream';
import { AppEnv, getPrescribedVideo, isUnlocked, loadPrescription, readJson, requireActiveLink, requirePatient } from './common';

// Patient routes, mounted at /api/watch. The link token identifies the
// prescription; a verified one-time-code session proves it's the patient.
export const patient = new Hono<AppEnv>();

patient.use('/:token', loadPrescription);
patient.use('/:token/*', loadPrescription);

const OTP_TTL_SECONDS = 10 * 60;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

// Interim completion rule (until full watch-time verification): at least
// 98% of the video's duration must have passed since the server first
// streamed it. Pausing only makes the gap longer.
export const MIN_WATCH_FRACTION = 0.98;

function sessionTag(sessionId: string): string {
  return sessionId.slice(0, 16);
}

// ------------------------------------------------------------ portal view

// Before verification this reveals nothing about the patient or procedure
// -- only where the code will be sent.
patient.get('/:token', async (c) => {
  const p = c.get('prescription');
  const hoursLeft = Math.max(0, hoursUntil(p.expires_at));
  const session = await getPatientSession(c, p.id);
  if (!session) {
    return c.json({ verified: false, codeDestination: maskEmail(p.patient_email), hoursLeft, certified: c.get('certified') });
  }

  const proc = await c.env.DB.prepare(`SELECT name FROM procedures WHERE id = ?`).bind(p.procedure_id).first<{ name: string }>();
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.order_index, v.duration_seconds, vp.started_at, vp.completed_at
     FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? ORDER BY v.order_index`
  ).bind(p.id).all<any>();

  // A video is unlocked once every earlier one is complete.
  let allBeforeDone = true;
  const videos = results.map((v) => {
    const unlocked = allBeforeDone;
    allBeforeDone = allBeforeDone && !!v.completed_at;
    return { ...v, unlocked, complete: !!v.completed_at };
  });

  return c.json({ verified: true, patientName: p.patient_name, procedureName: proc?.name, hoursLeft, certified: c.get('certified'), videos });
});

// ------------------------------------------------------- one-time codes

function sixDigitCode(): string {
  // Rejection sampling keeps every code equally likely.
  for (;;) {
    const n = new DataView(randomBytes(4).buffer).getUint32(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}

patient.post('/:token/otp/send', async (c) => {
  const p = c.get('prescription');
  if (await overLimit(c.env, `otp-ip:${clientIp(c.req.raw) ?? 'unknown'}`, 30, 3600)) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM patient_otps WHERE prescription_id = ? AND created_at > ?`
  ).bind(p.id, hourAgo).first<{ n: number; latest: string | null }>();
  if (recent?.latest && secondsSince(recent.latest) < OTP_RESEND_COOLDOWN_SECONDS) {
    return c.json({ error: 'Please wait a minute before requesting another code.' }, 429);
  }
  if ((recent?.n ?? 0) >= OTP_MAX_PER_HOUR) {
    return c.json({ error: 'Too many codes requested. Try again in an hour.' }, 429);
  }

  const code = sixDigitCode();
  await c.env.DB.prepare(
    `INSERT INTO patient_otps (id, prescription_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(uuid(), p.id, await hmacHex(c.env.OTP_SECRET, `${p.id}:${code}`), nowIso(), secondsFromNow(OTP_TTL_SECONDS)).run();

  try {
    await sendEmail(c.env, {
      to: p.patient_email,
      subject: `Your Aurelius verification code: ${code}`,
      text: `Your verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
    });
  } catch (err) {
    console.error('otp email failed', err);
    return c.json({ error: "We couldn't send your code. Please try again shortly." }, 502);
  }
  await logEvent(c.env, { prescriptionId: p.id, type: 'otp_sent', ip: clientIp(c.req.raw), meta: { channel: 'email', to: maskEmail(p.patient_email) } });
  return c.json({ sent: true, destination: maskEmail(p.patient_email), expiresInSeconds: OTP_TTL_SECONDS });
});

patient.post('/:token/otp/verify', async (c) => {
  const p = c.get('prescription');
  const ip = clientIp(c.req.raw);
  const body = await readJson(c);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'Enter the 6-digit code from your email.' }, 400);

  // Only the most recent code is ever valid.
  const otp = await c.env.DB.prepare(
    `SELECT id, code_hash, expires_at, consumed_at FROM patient_otps WHERE prescription_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(p.id).first<{ id: string; code_hash: string; expires_at: string; consumed_at: string | null }>();
  if (!otp || otp.consumed_at || otp.expires_at <= nowIso()) {
    return c.json({ error: 'This code has expired. Please request a new one.' }, 400);
  }

  // Count the attempt before checking it, atomically, so parallel guesses can't exceed the cap.
  const counted = await c.env.DB.prepare(
    `UPDATE patient_otps SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL RETURNING attempts`
  ).bind(otp.id, OTP_MAX_ATTEMPTS).first<{ attempts: number }>();
  if (!counted) return c.json({ error: 'Too many incorrect attempts. Please request a new code.' }, 429);

  const expected = await hmacHex(c.env.OTP_SECRET, `${p.id}:${code}`);
  if (!timingSafeEqual(expected, otp.code_hash)) {
    await logEvent(c.env, { prescriptionId: p.id, type: 'otp_failed', ip, meta: { attempt: counted.attempts } });
    return c.json({ error: 'That code is incorrect.', attemptsLeft: OTP_MAX_ATTEMPTS - counted.attempts }, 400);
  }

  const consumed = await c.env.DB.prepare(`UPDATE patient_otps SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(nowIso(), otp.id).run();
  if (consumed.meta.changes !== 1) return c.json({ error: 'This code has already been used. Please request a new one.' }, 400);

  const sessionId = await createPatientSession(c, p, otp.id, c.get('certified'));
  await logEvent(c.env, {
    prescriptionId: p.id,
    type: 'otp_verified',
    ip,
    meta: { method: 'email_one_time_code', destination: maskEmail(p.patient_email), session: sessionTag(sessionId), user_agent: c.req.header('User-Agent') ?? null },
  });
  return c.json({ verified: true });
});

// ------------------------------------------------------------- watching

patient.get('/:token/video/:videoId/stream', requireActiveLink, requirePatient, async (c) => {
  const p = c.get('prescription');
  const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
  if (!video) return c.json({ error: 'Not found.' }, 404);
  if (!(await isUnlocked(c.env, p.id, video.order_index))) {
    return c.json({ error: 'This video is locked until the previous one is finished.' }, 403);
  }

  const res = await serveR2Object(c.env.VIDEOS, video.r2_key, c.req.raw);
  if (!res) return c.json({ error: 'Not found.' }, 404);

  // The first real (GET) byte request that's actually served starts the clock.
  if (c.req.raw.method === 'GET' && res.ok && !video.started_at) {
    const startedAt = nowIso();
    await withChainRetry(
      () => prepareEvent(
        c.env,
        { prescriptionId: p.id, videoId: video.video_id, type: 'stream_start', ip: clientIp(c.req.raw), meta: { session: sessionTag(c.get('patient').sessionId) } },
        { onlyIfPreviousChanged: true }
      ),
      async (ev) => {
        await c.env.DB.batch([
          c.env.DB.prepare(`UPDATE video_progress SET started_at = ? WHERE id = ? AND started_at IS NULL`).bind(startedAt, video.progress_id),
          ev.stmt,
        ]);
      }
    );
  }
  return res;
});

async function overEventLimit(c: any, perMinute: number): Promise<boolean> {
  return overLimit(c.env, `events:${c.get('patient').sessionId}`, perMinute, 60);
}

// Client-reported seek attempt. Only ever increments a counter.
patient.post('/:token/video/:videoId/seek-attempt', requireActiveLink, requirePatient, async (c) => {
  const p = c.get('prescription');
  const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
  if (!video) return c.json({ error: 'Not found.' }, 404);
  if (await overEventLimit(c, 60)) return c.json({ error: 'Too many events.' }, 429);

  const body = await readJson(c);
  const meta: Record<string, unknown> = { source: 'client', session: sessionTag(c.get('patient').sessionId) };
  if (typeof body.from === 'number' && Number.isFinite(body.from)) meta.from = body.from;
  if (typeof body.to === 'number' && Number.isFinite(body.to)) meta.to = body.to;

  await withChainRetry(
    () => prepareEvent(c.env, { prescriptionId: p.id, videoId: video.video_id, type: 'seek_attempt', ip: clientIp(c.req.raw), meta }),
    async (ev) => {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE video_progress SET seek_attempts = seek_attempts + 1 WHERE id = ?`).bind(video.progress_id),
        ev.stmt,
      ]);
    }
  );
  return c.json({ ok: true });
});

// Client-reported play/pause. Pauses increment pause_count.
patient.post('/:token/video/:videoId/event', requireActiveLink, requirePatient, async (c) => {
  const p = c.get('prescription');
  const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
  if (!video) return c.json({ error: 'Not found.' }, 404);

  const body = await readJson(c);
  const type = body.type;
  if (type !== 'play' && type !== 'pause') return c.json({ error: 'type must be "play" or "pause".' }, 400);
  if (await overEventLimit(c, 30)) return c.json({ error: 'Too many events.' }, 429);

  const meta: Record<string, unknown> = { source: 'client', session: sessionTag(c.get('patient').sessionId) };
  if (typeof body.position === 'number' && Number.isFinite(body.position)) meta.position = body.position;

  await withChainRetry(
    () => prepareEvent(c.env, { prescriptionId: p.id, videoId: video.video_id, type, ip: clientIp(c.req.raw), meta }),
    async (ev) => {
      const stmts = [ev.stmt];
      if (type === 'pause') stmts.unshift(c.env.DB.prepare(`UPDATE video_progress SET pause_count = pause_count + 1 WHERE id = ?`).bind(video.progress_id));
      await c.env.DB.batch(stmts);
    }
  );
  return c.json({ ok: true });
});

// Marks a video complete -- only if it's this prescription's video, it's
// unlocked, the server has streamed it, and enough real time has passed.
// See MIN_WATCH_FRACTION; full watch-time verification replaces this check.
patient.post('/:token/video/:videoId/complete', requireActiveLink, requirePatient, async (c) => {
  const p = c.get('prescription');
  const ip = clientIp(c.req.raw);
  const session = sessionTag(c.get('patient').sessionId);
  const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
  if (!video) return c.json({ error: 'Not found.' }, 404);
  if (video.completed_at) return c.json({ ok: true, alreadyComplete: true });
  if (!(await isUnlocked(c.env, p.id, video.order_index))) {
    return c.json({ error: 'This video is locked until the previous one is finished.' }, 403);
  }
  if (!video.started_at) return c.json({ error: 'This video has not been played yet.' }, 409);

  const elapsed = secondsSince(video.started_at);
  const required = video.duration_seconds * MIN_WATCH_FRACTION;
  if (elapsed < required) {
    await logEvent(c.env, {
      prescriptionId: p.id, videoId: video.video_id, type: 'complete_rejected', ip,
      meta: { reason: 'too_early', elapsed_seconds: Math.floor(elapsed), required_seconds: Math.ceil(required), session },
    });
    return c.json({ error: 'The video has not been watched to the end yet.', secondsRemaining: Math.ceil(required - elapsed) }, 409);
  }

  const completedAt = nowIso();
  await withChainRetry(
    () => prepareEvent(
      c.env,
      {
        prescriptionId: p.id, videoId: video.video_id, type: 'complete', ip,
        meta: { verification_level: VERIFICATION_LEVEL, elapsed_seconds: Math.floor(elapsed), required_seconds: Math.ceil(required), session },
      },
      // Written only if this request is the one that set completed_at.
      { onlyIfPreviousChanged: true }
    ),
    async (ev) => {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE video_progress SET completed_at = ? WHERE id = ? AND completed_at IS NULL`).bind(completedAt, video.progress_id),
        ev.stmt,
      ]);
    }
  );

  let certificateIssued = false;
  try {
    certificateIssued = !!(await issueCertificateIfComplete(c.env, p.id));
  } catch (err) {
    // Completion stands; issuance is retried on the next certificate request.
    console.error('certificate issuance failed', err);
  }
  return c.json({ ok: true, certificateIssued });
});

// --------------------------------------------------------- certificate

patient.get('/:token/certificate', requirePatient, async (c) => {
  const p = c.get('prescription');
  const row = (await getCertificateRow(c.env, p.id)) ?? (await issueCertificateIfComplete(c.env, p.id));
  if (!row) return c.json({ error: 'Not all videos are complete yet.' }, 409);
  return c.json({
    certificate: JSON.parse(row.payload),
    // The exact signed bytes: POST /api/verify with { payload, signature } to check them.
    payload: row.payload,
    signature: row.signature,
    verificationCode: formatVerificationCode(row.verification_code),
  });
});
