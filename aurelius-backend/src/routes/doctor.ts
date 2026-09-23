import { Hono } from 'hono';
import { GENESIS_HASH, logEvent, prepareEvent, withChainRetry } from '../audit';
import { checkCertificate, formatVerificationCode, getCertificateRow, issueCertificateIfComplete } from '../certificate';
import { sendEmail } from '../email';
import { Env, clientIp, hoursFromNow, hoursUntil, isEmail, maskEmail, nowIso, randomToken, sha256Hex, uuid } from '../lib';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../password';
import { hitRateLimit, peekRateLimit } from '../ratelimit';
import { createDoctorSession, revokeDoctorSession } from '../sessions';
import { AppEnv, Prescription, readJson, requireDoctor } from './common';

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
    `SELECT pr.id, pr.patient_name, pr.patient_email, pr.created_at, pr.expires_at, pr.revoked_at, pr.revoked_reason,
            pr.replaces_prescription_id,
            (SELECT id FROM prescriptions nx WHERE nx.replaces_prescription_id = pr.id) AS replaced_by,
            proc.name AS procedure_name
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

interface NewPrescription {
  doctorId: string;
  doctorName: string;
  procedure: { id: string; name: string };
  patientName: string;
  patientEmail: string;
  ip: string | null;
  // Resend: the prescription this one replaces. Its revocation is written in
  // the same transaction, so there's never a moment with two live links.
  replaces?: { id: string; stmts: (newId: string) => Promise<D1PreparedStatement[]> };
}

// Creates the prescription, one progress row per video and the first audit
// event in a single transaction, then emails the patient their 48h link.
async function createPrescription(env: Env, input: NewPrescription): Promise<
  { ok: true; prescriptionId: string; watchUrl: string; expiresAt: string; emailSent: boolean } | { ok: false; status: 400 | 409; error: string }
> {
  const { results: videos } = await env.DB.prepare(`SELECT id FROM videos WHERE procedure_id = ? ORDER BY order_index`)
    .bind(input.procedure.id).all<{ id: string }>();
  if (videos.length === 0) return { ok: false, status: 400, error: 'This procedure has no videos yet.' };

  const prescriptionId = uuid();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const createdAt = nowIso();
  const expiresAt = hoursFromNow(Number(env.LINK_EXPIRY_HOURS || 48));

  try {
    await withChainRetry(
      async () => {
        const first = await prepareEvent(
          env,
          {
            prescriptionId, type: 'prescribed', ip: input.ip,
            meta: {
              doctor_id: input.doctorId, procedure_id: input.procedure.id, video_count: videos.length, expires_at: expiresAt,
              ...(input.replaces ? { replaces_prescription_id: input.replaces.id } : {}),
            },
          },
          { head: { seq: 0, hash: GENESIS_HASH } }
        );
        return [
          ...(input.replaces ? await input.replaces.stmts(prescriptionId) : []),
          env.DB.prepare(
            `INSERT INTO prescriptions (id, doctor_id, procedure_id, patient_name, patient_email, link_token_hash, created_at, expires_at, replaces_prescription_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(prescriptionId, input.doctorId, input.procedure.id, input.patientName, input.patientEmail, tokenHash, createdAt, expiresAt, input.replaces?.id ?? null),
          ...videos.map((v) =>
            env.DB.prepare(`INSERT INTO video_progress (id, prescription_id, video_id) VALUES (?, ?, ?)`).bind(uuid(), prescriptionId, v.id)
          ),
          first.stmt,
        ];
      },
      async (stmts) => { await env.DB.batch(stmts); }
    );
  } catch (err) {
    // Two resends of the same link racing: only one may replace it.
    if (/UNIQUE constraint failed: prescriptions\.replaces_prescription_id/.test(String((err as any)?.message ?? err))) {
      return { ok: false, status: 409, error: 'This link has already been resent.' };
    }
    throw err;
  }

  const watchUrl = `${env.APP_ORIGIN}/watch/${token}`;
  let emailSent = true;
  try {
    await sendEmail(env, {
      to: input.patientEmail,
      subject: input.replaces
        ? `Your new link for your ${input.procedure.name} information videos`
        : `${input.doctorName} has shared your ${input.procedure.name} information videos`,
      text:
        `Hello ${input.patientName},\n\n` +
        (input.replaces
          ? `${input.doctorName} has sent you a new link for your ${input.procedure.name} videos. Any earlier link no longer works.\n\n`
          : `${input.doctorName} has asked you to watch a short series of videos about your ${input.procedure.name}.\n\n`) +
        `Open this link to start (it expires in 48 hours):\n${watchUrl}\n\n` +
        `We'll email a one-time code to this address to confirm it's you before the first video.`,
    });
    await logEvent(env, { prescriptionId, type: 'link_sent', meta: { channel: 'email', to: maskEmail(input.patientEmail) } });
  } catch (err) {
    emailSent = false;
    console.error('link email failed', err);
    await logEvent(env, { prescriptionId, type: 'link_send_failed', meta: { channel: 'email', to: maskEmail(input.patientEmail), error: String(err).slice(0, 200) } });
  }

  return { ok: true, prescriptionId, watchUrl, expiresAt, emailSent };
}

function revokePatientSessions(env: Env, prescriptionId: string, at: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE patient_sessions SET revoked_at = ? WHERE prescription_id = ? AND revoked_at IS NULL`).bind(at, prescriptionId);
}

async function getOwnedPrescription(env: Env, id: string, doctorId: string): Promise<Prescription | null> {
  return env.DB.prepare(`SELECT * FROM prescriptions WHERE id = ? AND doctor_id = ?`).bind(id, doctorId).first<Prescription>();
}

doctor.post('/prescribe', async (c) => {
  const body = await readJson(c);
  const patientName = typeof body.patient_name === 'string' ? body.patient_name.trim() : '';
  const patientEmail = typeof body.patient_email === 'string' ? body.patient_email.trim() : '';
  const procedureId = typeof body.procedure_id === 'string' ? body.procedure_id : '';
  if (!patientName || patientName.length > 200) return c.json({ error: 'patient_name is required.' }, 400);
  if (!isEmail(patientEmail)) return c.json({ error: 'A valid patient_email is required.' }, 400);

  const procedure = await c.env.DB.prepare(`SELECT id, name FROM procedures WHERE id = ?`).bind(procedureId).first<{ id: string; name: string }>();
  if (!procedure) return c.json({ error: 'Unknown procedure.' }, 404);

  const result = await createPrescription(c.env, {
    doctorId: c.get('doctor').doctorId, doctorName: c.get('doctor').name, procedure, patientName, patientEmail, ip: clientIp(c.req.raw),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  // The link is shown to the doctor once, here. It can't be retrieved later.
  const { ok: _ok, ...response } = result;
  return c.json(response, 201);
});

// ---------------------------------------------------- resend and cancel

// Resend = a new prescription with a new token, a fresh 48 hours and fresh
// progress; the old link is revoked in the same transaction. Works for live,
// expired or cancelled links (e.g. to fix a mistyped email), but not for a
// set that's already certified, and each link can be replaced only once.
doctor.post('/prescriptions/:id/resend', async (c) => {
  const doctor = c.get('doctor');
  const old = await getOwnedPrescription(c.env, c.req.param('id'), doctor.doctorId);
  if (!old) return c.json({ error: 'Not found.' }, 404);
  if (await getCertificateRow(c.env, old.id)) return c.json({ error: 'This patient has already completed every video.' }, 409);
  const replaced = await c.env.DB.prepare(`SELECT id FROM prescriptions WHERE replaces_prescription_id = ?`).bind(old.id).first<{ id: string }>();
  if (replaced) return c.json({ error: 'This link has already been resent.', replacedBy: replaced.id }, 409);

  const body = await readJson(c);
  const patientEmail = body.patient_email === undefined ? old.patient_email : typeof body.patient_email === 'string' ? body.patient_email.trim() : '';
  if (!isEmail(patientEmail)) return c.json({ error: 'A valid patient_email is required.' }, 400);

  const procedure = await c.env.DB.prepare(`SELECT id, name FROM procedures WHERE id = ?`).bind(old.procedure_id).first<{ id: string; name: string }>();
  if (!procedure) return c.json({ error: 'Unknown procedure.' }, 404);

  const ip = clientIp(c.req.raw);
  const result = await createPrescription(c.env, {
    doctorId: doctor.doctorId, doctorName: doctor.name, procedure, patientName: old.patient_name, patientEmail, ip,
    replaces: {
      id: old.id,
      stmts: async (newId) => {
        const at = nowIso();
        const ev = await prepareEvent(c.env, {
          prescriptionId: old.id, type: 'link_replaced', ip,
          meta: {
            replaced_by: newId, by_doctor: doctor.doctorId, was: old.revoked_at ? `revoked:${old.revoked_reason}` : hoursUntil(old.expires_at) <= 0 ? 'expired' : 'active',
            ...(patientEmail !== old.patient_email ? { new_destination: maskEmail(patientEmail) } : {}),
          },
        });
        return [
          ev.stmt,
          c.env.DB.prepare(`UPDATE prescriptions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'resent') WHERE id = ?`).bind(at, old.id),
          revokePatientSessions(c.env, old.id, at),
        ];
      },
    },
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const { ok: _ok, ...response } = result;
  return c.json({ ...response, replaces: old.id }, 201);
});

// Cancel = revoke the link now. The patient can no longer open it and any
// verified sessions end. Not allowed once the set is certified, so the
// patient keeps access to their certificate.
doctor.post('/prescriptions/:id/cancel', async (c) => {
  const doctor = c.get('doctor');
  const p = await getOwnedPrescription(c.env, c.req.param('id'), doctor.doctorId);
  if (!p) return c.json({ error: 'Not found.' }, 404);
  if (p.revoked_at) return c.json({ ok: true, alreadyCancelled: true, revokedReason: p.revoked_reason });
  if (await getCertificateRow(c.env, p.id)) return c.json({ error: 'This patient has already completed every video.' }, 409);

  const body = await readJson(c);
  const note = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const at = nowIso();
  await withChainRetry(
    () => prepareEvent(
      c.env,
      { prescriptionId: p.id, type: 'link_cancelled', ip: clientIp(c.req.raw), meta: { by_doctor: doctor.doctorId, ...(note ? { reason: note } : {}) } },
      // Logged only if this request is the one that revoked the link.
      { onlyIfPreviousChanged: true }
    ),
    async (ev) => {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE prescriptions SET revoked_at = ?, revoked_reason = 'cancelled' WHERE id = ? AND revoked_at IS NULL`).bind(at, p.id),
        ev.stmt,
        revokePatientSessions(c.env, p.id, at),
      ]);
    }
  );
  return c.json({ ok: true });
});
