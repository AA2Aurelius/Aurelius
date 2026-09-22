import { Hono } from 'hono';
import { GENESIS_HASH, logEvent, prepareEvent } from '../audit';
import { checkCertificate, formatVerificationCode, issueCertificateIfComplete } from '../certificate';
import { sendEmail } from '../email';
import { clientIp, hoursFromNow, hoursUntil, isEmail, maskEmail, nowIso, randomToken, sha256Hex, uuid } from '../lib';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../password';
import { hitRateLimit, peekRateLimit } from '../ratelimit';
import { createDoctorSession, revokeDoctorSession } from '../sessions';
import { AppEnv, readJson, requireDoctor } from './common';

export const doctor = new Hono<AppEnv>();

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES_PER_EMAIL = 5;
const LOGIN_MAX_FAILURES_PER_IP = 20;

// ---------------------------------------------------------------- sign in

// Registered before requireDoctor, so it's the only unauthenticated route.
doctor.post('/login', async (c) => {
  const body = await readJson(c);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return c.json({ error: 'Email and password are required.' }, 400);

  const emailKey = `login:email:${email}`;
  const ipKey = `login:ip:${clientIp(c.req.raw) ?? 'unknown'}`;
  if (
    (await peekRateLimit(c.env, emailKey, LOGIN_WINDOW_SECONDS)) >= LOGIN_MAX_FAILURES_PER_EMAIL ||
    (await peekRateLimit(c.env, ipKey, LOGIN_WINDOW_SECONDS)) >= LOGIN_MAX_FAILURES_PER_IP
  ) {
    return c.json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' }, 429);
  }

  const doc = await c.env.DB.prepare(`SELECT id, name, email, password_hash, disabled_at FROM doctors WHERE email = ?`)
    .bind(email).first<{ id: string; name: string; email: string; password_hash: string; disabled_at: string | null }>();
  // Always run the hash, so response time doesn't reveal whether the email exists.
  const passwordOk = await verifyPassword(password, doc?.password_hash ?? DUMMY_PASSWORD_HASH);

  if (!doc || !passwordOk || doc.disabled_at) {
    await hitRateLimit(c.env, emailKey, LOGIN_WINDOW_SECONDS);
    await hitRateLimit(c.env, ipKey, LOGIN_WINDOW_SECONDS);
    return c.json({ error: 'Invalid email or password.' }, 401);
  }

  await createDoctorSession(c, doc.id);
  return c.json({ doctor: { id: doc.id, name: doc.name, email: doc.email } });
});

// Every route below requires a signed-in doctor.
doctor.use('*', requireDoctor);

doctor.post('/logout', async (c) => {
  await revokeDoctorSession(c);
  return c.json({ ok: true });
});

doctor.get('/me', (c) => {
  const d = c.get('doctor');
  return c.json({ id: d.doctorId, name: d.name, email: d.email });
});

// --------------------------------------------------------------- library

// Procedures + their videos, for the "prescribe" picker. Paginate/search
// server-side once the library grows past a page or two.
doctor.get('/procedures', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, COUNT(v.id) AS video_count
     FROM procedures p LEFT JOIN videos v ON v.procedure_id = p.id
     GROUP BY p.id ORDER BY p.name`
  ).all();
  return c.json(results);
});

// -------------------------------------------------------------- patients

// The signed-in doctor's patients with live progress. Link tokens are never
// returned here -- only their hashes are stored.
doctor.get('/patients', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT pr.id, pr.patient_name, pr.created_at, pr.expires_at,
            proc.name AS procedure_name,
            (SELECT COUNT(*) FROM video_progress vp
               WHERE vp.prescription_id = pr.id AND vp.completed_at IS NOT NULL) AS videos_done,
            (SELECT COUNT(*) FROM video_progress vp WHERE vp.prescription_id = pr.id) AS videos_total,
            (SELECT issued_at FROM certificates cert WHERE cert.prescription_id = pr.id) AS certified_at
     FROM prescriptions pr
     JOIN procedures proc ON proc.id = pr.procedure_id
     WHERE pr.doctor_id = ? AND pr.revoked_at IS NULL
     ORDER BY pr.created_at DESC`
  ).bind(c.get('doctor').doctorId).all();
  return c.json(results.map((r: any) => ({ ...r, hours_left: Math.max(0, hoursUntil(r.expires_at)) })));
});

// Per-video progress for one of this doctor's prescriptions.
doctor.get('/prescriptions/:id', async (c) => {
  const p = await c.env.DB.prepare(
    `SELECT pr.id, pr.patient_name, pr.patient_email, pr.created_at, pr.expires_at, proc.name AS procedure_name
     FROM prescriptions pr JOIN procedures proc ON proc.id = pr.procedure_id
     WHERE pr.id = ? AND pr.doctor_id = ?`
  ).bind(c.req.param('id'), c.get('doctor').doctorId).first<any>();
  if (!p) return c.json({ error: 'Not found.' }, 404);

  const { results: videos } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.order_index, v.duration_seconds, vp.started_at, vp.completed_at, vp.seek_attempts, vp.pause_count
     FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? ORDER BY v.order_index`
  ).bind(p.id).all();
  return c.json({ ...p, hours_left: Math.max(0, hoursUntil(p.expires_at)), videos });
});

// The full certificate (the public verify page shows only a summary).
doctor.get('/prescriptions/:id/certificate', async (c) => {
  const owned = await c.env.DB.prepare(`SELECT id FROM prescriptions WHERE id = ? AND doctor_id = ?`)
    .bind(c.req.param('id'), c.get('doctor').doctorId).first<{ id: string }>();
  if (!owned) return c.json({ error: 'Not found.' }, 404);

  const row = await issueCertificateIfComplete(c.env, owned.id);
  if (!row) return c.json({ error: 'Not all videos are complete yet.' }, 409);
  const check = await checkCertificate(c.env, row);
  return c.json({
    certificate: check.payload,
    payload: row.payload,
    signature: row.signature,
    verificationCode: formatVerificationCode(row.verification_code),
    integrity: { valid: check.valid, problems: check.problems },
  });
});

// ------------------------------------------------------------- prescribe

// Creates the prescription, one progress row per video and the first audit
// event in a single transaction, then emails the patient their 48h link.
doctor.post('/prescribe', async (c) => {
  const doctorId = c.get('doctor').doctorId;
  const body = await readJson(c);
  const patientName = typeof body.patient_name === 'string' ? body.patient_name.trim() : '';
  const patientEmail = typeof body.patient_email === 'string' ? body.patient_email.trim() : '';
  const procedureId = typeof body.procedure_id === 'string' ? body.procedure_id : '';
  if (!patientName || patientName.length > 200) return c.json({ error: 'patient_name is required.' }, 400);
  if (!isEmail(patientEmail)) return c.json({ error: 'A valid patient_email is required.' }, 400);

  const procedure = await c.env.DB.prepare(`SELECT id, name FROM procedures WHERE id = ?`).bind(procedureId).first<{ id: string; name: string }>();
  if (!procedure) return c.json({ error: 'Unknown procedure.' }, 404);
  const { results: videos } = await c.env.DB.prepare(`SELECT id FROM videos WHERE procedure_id = ? ORDER BY order_index`)
    .bind(procedure.id).all<{ id: string }>();
  if (videos.length === 0) return c.json({ error: 'This procedure has no videos yet.' }, 400);

  const prescriptionId = uuid();
  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = hoursFromNow(Number(c.env.LINK_EXPIRY_HOURS || 48));

  const first = await prepareEvent(
    c.env,
    { prescriptionId, type: 'prescribed', ip: clientIp(c.req.raw), meta: { doctor_id: doctorId, procedure_id: procedure.id, video_count: videos.length, expires_at: expiresAt } },
    { head: { seq: 0, hash: GENESIS_HASH } }
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO prescriptions (id, doctor_id, procedure_id, patient_name, patient_email, link_token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(prescriptionId, doctorId, procedure.id, patientName, patientEmail, await sha256Hex(token), createdAt, expiresAt),
    ...videos.map((v) =>
      c.env.DB.prepare(`INSERT INTO video_progress (id, prescription_id, video_id) VALUES (?, ?, ?)`).bind(uuid(), prescriptionId, v.id)
    ),
    first.stmt,
  ]);

  const watchUrl = `${c.env.APP_ORIGIN}/watch/${token}`;
  let emailSent = true;
  try {
    await sendEmail(c.env, {
      to: patientEmail,
      subject: `${c.get('doctor').name} has shared your ${procedure.name} information videos`,
      text:
        `Hello ${patientName},\n\n` +
        `${c.get('doctor').name} has asked you to watch a short series of videos about your ${procedure.name}.\n\n` +
        `Open this link to start (it expires in 48 hours):\n${watchUrl}\n\n` +
        `We'll email a one-time code to this address to confirm it's you before the first video.`,
    });
    await logEvent(c.env, { prescriptionId, type: 'link_sent', meta: { channel: 'email', to: maskEmail(patientEmail) } });
  } catch (err) {
    emailSent = false;
    console.error('link email failed', err);
    await logEvent(c.env, { prescriptionId, type: 'link_send_failed', meta: { channel: 'email', to: maskEmail(patientEmail), error: String(err).slice(0, 200) } });
  }

  // The link is shown to the doctor once, here. It can't be retrieved later.
  return c.json({ prescriptionId, watchUrl, expiresAt, emailSent }, 201);
});
