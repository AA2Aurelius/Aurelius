import { Hono } from 'hono';
import { Env, uuid, linkToken, hoursFromNow, hoursUntil } from './lib';

const app = new Hono<{ Bindings: Env }>();

// =====================================================================
// DOCTOR-SIDE (would sit behind real auth middleware -- see NOTE below)
// =====================================================================

// NOTE: this scaffold leaves doctor authentication as a stub. Wire up
// a real session/JWT check (e.g. a Hono middleware reading a signed
// cookie) before this touches real patient data. Every /doctor/* route
// below should reject unauthenticated requests.

// List procedures + their videos, for the "prescribe" picker.
// Built to scale to dozens of procedures: paginate/search server-side
// once the library grows past a page or two.
app.get('/doctor/procedures', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, COUNT(v.id) as video_count
     FROM procedures p LEFT JOIN videos v ON v.procedure_id = p.id
     GROUP BY p.id ORDER BY p.name`
  ).all();
  return c.json(results);
});

// Doctor's patient list with live progress + hours remaining, for the
// tracking panel. Patients never see this endpoint.
app.get('/doctor/patients', async (c) => {
  const doctorId = c.req.header('X-Doctor-Id'); // TODO: replace with real session
  const { results } = await c.env.DB.prepare(
    `SELECT pr.id, pr.patient_name, pr.expires_at, pr.link_token,
            proc.name as procedure_name,
            (SELECT COUNT(*) FROM video_progress vp
               WHERE vp.prescription_id = pr.id AND vp.completed_at IS NOT NULL) as videos_done,
            (SELECT COUNT(*) FROM videos v WHERE v.procedure_id = pr.procedure_id) as videos_total
     FROM prescriptions pr
     JOIN procedures proc ON proc.id = pr.procedure_id
     WHERE pr.doctor_id = ? AND pr.revoked_at IS NULL
     ORDER BY pr.created_at DESC`
  ).bind(doctorId).all();

  const withHours = results.map((r: any) => ({ ...r, hours_left: Math.max(0, hoursUntil(r.expires_at)) }));
  return c.json(withHours);
});

// Prescribe a procedure's video set to a patient: creates the prescription,
// a video_progress row per video (all incomplete), and the 48h link.
app.post('/doctor/prescribe', async (c) => {
  const doctorId = c.req.header('X-Doctor-Id'); // TODO: real session
  const body = await c.req.json<{ patient_name: string; patient_email?: string; procedure_id: string }>();

  const expiryHours = Number(c.env.LINK_EXPIRY_HOURS || 48);
  const prescriptionId = uuid();
  const token = linkToken();

  await c.env.DB.prepare(
    `INSERT INTO prescriptions (id, doctor_id, procedure_id, patient_name, patient_email, link_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(prescriptionId, doctorId, body.procedure_id, body.patient_name, body.patient_email ?? null, token, hoursFromNow(expiryHours)).run();

  const { results: videos } = await c.env.DB.prepare(
    `SELECT id FROM videos WHERE procedure_id = ? ORDER BY order_index`
  ).bind(body.procedure_id).all();

  for (const v of videos as any[]) {
    await c.env.DB.prepare(
      `INSERT INTO video_progress (id, prescription_id, video_id) VALUES (?, ?, ?)`
    ).bind(uuid(), prescriptionId, v.id).run();
  }

  await logEvent(c.env, prescriptionId, null, 'link_sent');

  // TODO: send the actual email/SMS with the watch link here via RESEND_API_KEY
  const watchUrl = `https://your-domain.example/watch/${token}`;
  return c.json({ prescriptionId, watchUrl, expiresAt: hoursFromNow(expiryHours) });
});

// =====================================================================
// PATIENT-SIDE (token in the URL IS the auth -- no login for patients)
// =====================================================================

// Everything the patient portal needs to render: procedure name, the 6
// videos with per-video completion state, and hours remaining.
app.get('/watch/:token', async (c) => {
  const token = c.req.param('token');
  const prescription = await getValidPrescription(c.env, token);
  if (!prescription) return c.json({ error: 'This link is invalid or has expired.' }, 410);

  const { results: videos } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.order_index, vp.completed_at, vp.started_at
     FROM videos v
     JOIN video_progress vp ON vp.video_id = v.id AND vp.prescription_id = ?
     WHERE v.procedure_id = ?
     ORDER BY v.order_index`
  ).bind(prescription.id, prescription.procedure_id).all();

  return c.json({
    patientName: prescription.patient_name,
    procedureId: prescription.procedure_id,
    hoursLeft: Math.max(0, hoursUntil(prescription.expires_at)),
    videos,
  });
});

// Signed, time-limited URL to the actual video bytes in R2. Never expose
// the raw R2 key or a permanent URL -- always mint one of these per view,
// and refuse to serve a video that isn't the patient's current unlocked one.
app.get('/watch/:token/video/:videoId/stream', async (c) => {
  const token = c.req.param('token');
  const videoId = c.req.param('videoId');
  const prescription = await getValidPrescription(c.env, token);
  if (!prescription) return c.json({ error: 'expired' }, 410);

  if (!(await isVideoUnlocked(c.env, prescription.id, prescription.procedure_id, videoId))) {
    return c.json({ error: 'This video is locked until the previous one is finished.' }, 403);
  }

  const video = await c.env.DB.prepare(`SELECT r2_key FROM videos WHERE id = ?`).bind(videoId).first<{ r2_key: string }>();
  if (!video) return c.json({ error: 'not found' }, 404);

  const obj = await c.env.VIDEOS.get(video.r2_key);
  if (!obj) return c.json({ error: 'not found' }, 404);

  await markStarted(c.env, prescription.id, videoId);
  return new Response(obj.body, { headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' } });
});

// The client reports a seek attempt (for the audit trail); the server
// does NOT trust the client to self-report completion this way -- this
// endpoint only ever increments a counter, never marks a video done.
app.post('/watch/:token/video/:videoId/seek-attempt', async (c) => {
  const token = c.req.param('token');
  const videoId = c.req.param('videoId');
  const prescription = await getValidPrescription(c.env, token);
  if (!prescription) return c.json({ error: 'expired' }, 410);

  await c.env.DB.prepare(
    `UPDATE video_progress SET seek_attempts = seek_attempts + 1
     WHERE prescription_id = ? AND video_id = ?`
  ).bind(prescription.id, videoId).run();
  await logEvent(c.env, prescription.id, videoId, 'seek_attempt', c.req.header('CF-Connecting-IP'));
  return c.json({ ok: true });
});

// THE important endpoint: marks a video complete. This must only be
// called after the server itself has confirmed the video was watched
// start-to-finish -- e.g. by tracking server-side playback time via the
// /stream range requests, or requiring the client to hit periodic
// heartbeat checkpoints it cannot fast-forward through. This scaffold
// leaves that verification as a TODO; do not ship a version where the
// client can call this endpoint on its own say-so.
app.post('/watch/:token/video/:videoId/complete', async (c) => {
  const token = c.req.param('token');
  const videoId = c.req.param('videoId');
  const prescription = await getValidPrescription(c.env, token);
  if (!prescription) return c.json({ error: 'expired' }, 410);

  // TODO: verify server-side watch time here before writing completed_at.

  await c.env.DB.prepare(
    `UPDATE video_progress SET completed_at = datetime('now')
     WHERE prescription_id = ? AND video_id = ?`
  ).bind(prescription.id, videoId).run();
  await logEvent(c.env, prescription.id, videoId, 'complete', c.req.header('CF-Connecting-IP'));

  return c.json({ ok: true });
});

// Certificate data -- only returns once all videos for the prescription
// are complete. The frontend renders this into the printable/PDF certificate.
app.get('/watch/:token/certificate', async (c) => {
  const token = c.req.param('token');
  const prescription = await getValidPrescription(c.env, token, { allowExpiredIfComplete: true });
  if (!prescription) return c.json({ error: 'expired' }, 410);

  const { results: progress } = await c.env.DB.prepare(
    `SELECT vp.completed_at, vp.seek_attempts, v.title, v.order_index
     FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? ORDER BY v.order_index`
  ).bind(prescription.id).all();

  const allDone = (progress as any[]).every(p => p.completed_at);
  if (!allDone) return c.json({ error: 'Not all videos are complete yet.' }, 400);

  const lastCompleted = (progress as any[]).reduce((latest, p) =>
    p.completed_at > latest ? p.completed_at : latest, (progress as any[])[0].completed_at);
  const totalSeekAttempts = (progress as any[]).reduce((sum, p) => sum + p.seek_attempts, 0);

  const proc = await c.env.DB.prepare(`SELECT name FROM procedures WHERE id = ?`).bind(prescription.procedure_id).first<{ name: string }>();

  return c.json({
    patientName: prescription.patient_name,
    procedureName: proc?.name,
    completedAt: lastCompleted,
    videosWatched: progress.length,
    totalSeekAttempts,
    verificationCode: `AUR-${prescription.id.slice(0, 8).toUpperCase()}`,
  });
});

// =====================================================================
// CRON: fires 12h-remaining reminders (scheduled handler, see index export)
// =====================================================================

export async function runReminderSweep(env: Env) {
  const threshold = Number(env.REMINDER_HOURS_BEFORE_EXPIRY || 12);
  const { results } = await env.DB.prepare(
    `SELECT id, doctor_id, patient_name, patient_email, expires_at
     FROM prescriptions
     WHERE reminder_12h_sent_at IS NULL AND revoked_at IS NULL`
  ).all();

  for (const p of results as any[]) {
    const left = hoursUntil(p.expires_at);
    if (left <= threshold && left > 0) {
      // TODO: send actual email/SMS/push to both patient and doctor here.
      await env.DB.prepare(`UPDATE prescriptions SET reminder_12h_sent_at = datetime('now') WHERE id = ?`).bind(p.id).run();
      await logEvent(env, p.id, null, 'reminder_12h');
    }
  }
}

// ---- helpers ----

async function getValidPrescription(env: Env, token: string, opts?: { allowExpiredIfComplete?: boolean }) {
  const p = await env.DB.prepare(
    `SELECT * FROM prescriptions WHERE link_token = ? AND revoked_at IS NULL`
  ).bind(token).first<any>();
  if (!p) return null;
  if (hoursUntil(p.expires_at) <= 0 && !opts?.allowExpiredIfComplete) return null;
  return p;
}

async function isVideoUnlocked(env: Env, prescriptionId: string, procedureId: string, videoId: string) {
  const target = await env.DB.prepare(`SELECT order_index FROM videos WHERE id = ?`).bind(videoId).first<{ order_index: number }>();
  if (!target) return false;
  if (target.order_index === 1) return true;
  const prior = await env.DB.prepare(
    `SELECT vp.completed_at FROM videos v JOIN video_progress vp ON vp.video_id = v.id AND vp.prescription_id = ?
     WHERE v.procedure_id = ? AND v.order_index = ?`
  ).bind(prescriptionId, procedureId, target.order_index - 1).first<{ completed_at: string | null }>();
  return !!prior?.completed_at;
}

async function markStarted(env: Env, prescriptionId: string, videoId: string) {
  await env.DB.prepare(
    `UPDATE video_progress SET started_at = COALESCE(started_at, datetime('now'))
     WHERE prescription_id = ? AND video_id = ?`
  ).bind(prescriptionId, videoId).run();
}

async function logEvent(env: Env, prescriptionId: string, videoId: string | null, type: string, ip?: string | null) {
  await env.DB.prepare(
    `INSERT INTO progress_events (id, prescription_id, video_id, event_type, client_ip) VALUES (?, ?, ?, ?, ?)`
  ).bind(uuid(), prescriptionId, videoId, type, ip ?? null).run();
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    await runReminderSweep(env);
  },
};
