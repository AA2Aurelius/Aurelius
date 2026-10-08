import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sendEmail } from '../email';
import { clientIp, hoursFromNow, isEmail, nowIso, randomToken, secondsFromNow, sha256Hex, uuid } from '../lib';
import { decryptSecret, encryptSecret, hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../mfa';
import { hashPassword, verifyPassword } from '../password';
import { hitRateLimit, overLimit, peekRateLimit } from '../ratelimit';
import { createDoctorSession } from '../sessions';
import { AppEnv, readJson } from './common';

// Practices, their team, and two-step sign-in. Accounts live in the doctors
// table with a role: 'doctor' (can prescribe and manage the team) or
// 'staff' (sends and follows invites on a doctor's behalf).

const MFA_COOKIE = '__Host-aur_mfa';
const MFA_CHALLENGE_SECONDS = 5 * 60;
const MFA_MAX_ATTEMPTS = 5;
const INVITE_DAYS = 7;
const MIN_PASSWORD = 12;

type Ctx = Context<AppEnv>;

// After a correct password, for an account with two-step sign-in.
export async function startMfaChallenge(c: Ctx, doctorId: string): Promise<void> {
  const token = randomToken();
  await c.env.DB.prepare(`INSERT INTO mfa_challenges (id, doctor_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256Hex(token), doctorId, nowIso(), secondsFromNow(MFA_CHALLENGE_SECONDS)).run();
  setCookie(c, MFA_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: MFA_CHALLENGE_SECONDS });
}

// A code from the authenticator app, or (if the phone is lost) one of the
// recovery codes, which then can't be used again.
async function checkSecondFactor(c: Ctx, doctorId: string, input: string): Promise<'totp' | 'recovery' | null> {
  const row = await c.env.DB.prepare(`SELECT totp_secret_enc, totp_last_step, recovery_codes FROM doctors WHERE id = ?`)
    .bind(doctorId).first<{ totp_secret_enc: string | null; totp_last_step: number | null; recovery_codes: string | null }>();
  if (!row?.totp_secret_enc) return null;
  const code = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(code)) {
    const step = await verifyTotp(await decryptSecret(c.env, row.totp_secret_enc), code, row.totp_last_step);
    if (step === null) return null;
    // Only one sign-in per time-step, even if two race.
    const used = await c.env.DB.prepare(`UPDATE doctors SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`)
      .bind(step, doctorId, step).run();
    return used.meta.changes === 1 ? 'totp' : null;
  }
  const hashes: string[] = row.recovery_codes ? JSON.parse(row.recovery_codes) : [];
  const h = await hashRecoveryCode(code);
  if (!hashes.includes(h)) return null;
  const left = JSON.stringify(hashes.filter((x) => x !== h));
  const used = await c.env.DB.prepare(`UPDATE doctors SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?`)
    .bind(left, doctorId, row.recovery_codes).run();
  return used.meta.changes === 1 ? 'recovery' : null;
}

async function accountEmailTaken(c: Ctx, email: string): Promise<boolean> {
  return !!(await c.env.DB.prepare(`SELECT 1 FROM doctors WHERE email = ?`).bind(email).first());
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Choose a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'That password is too long.';
  return null;
}

// --------------------------------------------- before signing in

export function registerSignInRoutes(app: Hono<AppEnv>) {
  app.post('/login/mfa', async (c) => {
    const token = getCookie(c, MFA_COOKIE);
    if (!token) return c.json({ error: 'Please sign in again.' }, 401);
    const ipKey = `mfa:ip:${clientIp(c.req.raw) ?? 'unknown'}`;
    if ((await peekRateLimit(c.env, ipKey, 900)) >= 20) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const id = await sha256Hex(token);
    const counted = await c.env.DB.prepare(
      `UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING doctor_id, attempts`
    ).bind(id, nowIso(), MFA_MAX_ATTEMPTS).first<{ doctor_id: string; attempts: number }>();
    if (!counted) {
      deleteCookie(c, MFA_COOKIE, { path: '/', secure: true });
      return c.json({ error: 'This sign-in has expired or had too many attempts. Please sign in again.' }, 401);
    }
    const body = await readJson(c);
    const code = typeof body.code === 'string' ? body.code : '';
    const how = await checkSecondFactor(c, counted.doctor_id, code);
    if (!how) {
      await hitRateLimit(c.env, ipKey, 900);
      return c.json({ error: 'That code is not right. Check your authenticator app and try again.', attemptsLeft: MFA_MAX_ATTEMPTS - counted.attempts }, 400);
    }
    await c.env.DB.prepare(`UPDATE mfa_challenges SET used_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    deleteCookie(c, MFA_COOKIE, { path: '/', secure: true });
    const doc = await c.env.DB.prepare(`SELECT id, name, email, recovery_codes FROM doctors WHERE id = ? AND disabled_at IS NULL`)
      .bind(counted.doctor_id).first<{ id: string; name: string; email: string; recovery_codes: string | null }>();
    if (!doc) return c.json({ error: 'This account is disabled.' }, 401);
    await createDoctorSession(c, doc.id);
    const recoveryLeft = doc.recovery_codes ? (JSON.parse(doc.recovery_codes) as string[]).length : 0;
    return c.json({ doctor: { id: doc.id, name: doc.name, email: doc.email }, usedRecoveryCode: how === 'recovery', recoveryCodesLeft: recoveryLeft });
  });

  // An emailed invitation to join a practice.
  app.get('/join/:token', async (c) => {
    const inv = await openInvite(c, c.req.param('token'));
    if (!inv) return c.json({ error: 'This invitation has expired or was already used. Ask for a new one.' }, 410);
    return c.json({ name: inv.name, email: inv.email, role: inv.role, practice: inv.practice_name });
  });

  app.post('/join/:token', async (c) => {
    if (await overLimit(c.env, `join:${clientIp(c.req.raw) ?? 'unknown'}`, 20, 3600)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
    const inv = await openInvite(c, c.req.param('token'));
    if (!inv) return c.json({ error: 'This invitation has expired or was already used. Ask for a new one.' }, 410);
    const body = await readJson(c);
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: problem }, 400);
    if (await accountEmailTaken(c, inv.email)) return c.json({ error: 'An account with this email already exists. Sign in instead.' }, 409);
    const claimed = await c.env.DB.prepare(`UPDATE account_invites SET used_at = ? WHERE id = ? AND used_at IS NULL`).bind(nowIso(), inv.id).run();
    if (claimed.meta.changes !== 1) return c.json({ error: 'This invitation was already used.' }, 410);
    const id = uuid();
    await c.env.DB.prepare(`INSERT INTO doctors (id, name, email, password_hash, created_at, practice_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inv.name, inv.email, await hashPassword(body.password as string), nowIso(), inv.practice_id, inv.role).run();
    await createDoctorSession(c, id);
    return c.json({ doctor: { id, name: inv.name, email: inv.email } }, 201);
  });
}

async function openInvite(c: Ctx, token: string | undefined) {
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT i.id, i.name, i.email, i.role, i.practice_id, p.name AS practice_name FROM account_invites i JOIN practices p ON p.id = i.practice_id
     WHERE i.id = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`
  ).bind(await sha256Hex(token), nowIso()).first<{ id: string; name: string; email: string; role: string; practice_id: string; practice_name: string }>();
}

// --------------------------------------------- signed in

export function registerAccountRoutes(app: Hono<AppEnv>) {
  // ---- two-step sign-in

  app.get('/mfa', async (c) => {
    const d = c.get('doctor');
    const row = await c.env.DB.prepare(`SELECT totp_enabled_at, recovery_codes FROM doctors WHERE id = ?`).bind(d.doctorId)
      .first<{ totp_enabled_at: string | null; recovery_codes: string | null }>();
    return c.json({
      enabled: !!row?.totp_enabled_at, enabledAt: row?.totp_enabled_at ?? null, required: d.practiceRequiresMfa,
      recoveryCodesLeft: row?.recovery_codes ? (JSON.parse(row.recovery_codes) as string[]).length : 0,
    });
  });

  // Step 1: a new secret for the authenticator app (shown as a QR code).
  app.post('/mfa/setup', async (c) => {
    const d = c.get('doctor');
    if (d.mfaEnabled) return c.json({ error: 'Two-step sign-in is already on.' }, 409);
    const secret = newTotpSecret();
    await c.env.DB.prepare(`UPDATE doctors SET totp_pending_enc = ? WHERE id = ?`).bind(await encryptSecret(c.env, secret), d.doctorId).run();
    return c.json({ secret, uri: otpauthUri(secret, d.email) });
  });

  // Step 2: the first code from the app proves it's set up. Returns the
  // recovery codes, shown once.
  app.post('/mfa/enable', async (c) => {
    const d = c.get('doctor');
    if (await overLimit(c.env, `mfa-enable:${d.doctorId}`, 10, 900)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const row = await c.env.DB.prepare(`SELECT totp_pending_enc, totp_enabled_at FROM doctors WHERE id = ?`).bind(d.doctorId)
      .first<{ totp_pending_enc: string | null; totp_enabled_at: string | null }>();
    if (row?.totp_enabled_at) return c.json({ error: 'Two-step sign-in is already on.' }, 409);
    if (!row?.totp_pending_enc) return c.json({ error: 'Start the setup again.' }, 409);
    const body = await readJson(c);
    const step = await verifyTotp(await decryptSecret(c.env, row.totp_pending_enc), typeof body.code === 'string' ? body.code.trim() : '', null);
    if (step === null) return c.json({ error: 'That code is not right. Type the 6 numbers your authenticator app shows now.' }, 400);
    const codes = newRecoveryCodes();
    await c.env.DB.prepare(
      `UPDATE doctors SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = ?, totp_last_step = ?, recovery_codes = ? WHERE id = ?`
    ).bind(nowIso(), step, JSON.stringify(await Promise.all(codes.map(hashRecoveryCode))), d.doctorId).run();
    return c.json({ enabled: true, recoveryCodes: codes });
  });

  app.post('/mfa/recovery-codes', async (c) => {
    const d = c.get('doctor');
    if (!d.mfaEnabled) return c.json({ error: 'Turn on two-step sign-in first.' }, 409);
    if (!(await passwordMatches(c, d.doctorId, (await readJson(c)).password))) return c.json({ error: 'That password is not right.' }, 400);
    const codes = newRecoveryCodes();
    await c.env.DB.prepare(`UPDATE doctors SET recovery_codes = ? WHERE id = ?`).bind(JSON.stringify(await Promise.all(codes.map(hashRecoveryCode))), d.doctorId).run();
    return c.json({ recoveryCodes: codes });
  });

  app.post('/mfa/disable', async (c) => {
    const d = c.get('doctor');
    if (d.practiceRequiresMfa) return c.json({ error: 'Your practice requires two-step sign-in, so it can\'t be turned off.' }, 409);
    if (!(await passwordMatches(c, d.doctorId, (await readJson(c)).password))) return c.json({ error: 'That password is not right.' }, 400);
    await c.env.DB.prepare(
      `UPDATE doctors SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?`
    ).bind(d.doctorId).run();
    return c.json({ enabled: false });
  });

  // ---- the practice's team

  app.get('/team', async (c) => {
    const d = c.get('doctor');
    if (!d.practiceId) {
      return c.json({ practice: null, members: [{ id: d.doctorId, name: d.name, email: d.email, role: d.role, mfa: d.mfaEnabled, disabled: false, me: true }], invites: [] });
    }
    const practice = await c.env.DB.prepare(`SELECT id, name, require_mfa FROM practices WHERE id = ?`).bind(d.practiceId).first<{ id: string; name: string; require_mfa: number }>();
    const { results: members } = await c.env.DB.prepare(
      `SELECT id, name, email, role, totp_enabled_at IS NOT NULL AS mfa, disabled_at IS NOT NULL AS disabled FROM doctors WHERE practice_id = ? ORDER BY disabled_at IS NOT NULL, role, name`
    ).bind(d.practiceId).all<any>();
    const { results: invites } = await c.env.DB.prepare(
      `SELECT id, name, email, role, created_at, expires_at FROM account_invites WHERE practice_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
    ).bind(d.practiceId, nowIso()).all<any>();
    return c.json({
      practice: practice ? { id: practice.id, name: practice.name, requireMfa: !!practice.require_mfa } : null,
      members: members.map((m) => ({ ...m, mfa: !!m.mfa, disabled: !!m.disabled, me: m.id === d.doctorId })),
      // The invite id is a token hash; a short form is enough to cancel it.
      invites: invites.map((i) => ({ ...i, id: i.id.slice(0, 16) })),
    });
  });

  // Doctors add people to their practice. A doctor working alone gets a
  // practice the first time they add someone.
  app.post('/team/invite', async (c) => {
    const d = c.get('doctor');
    if (d.role !== 'doctor') return c.json({ error: 'Only doctors can add people to the practice.' }, 403);
    if (await overLimit(c.env, `team-invite:${d.doctorId}`, 20, 86400)) return c.json({ error: 'Too many invitations today. Try again tomorrow.' }, 429);
    const body = await readJson(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = body.role === 'doctor' ? 'doctor' : body.role === 'staff' ? 'staff' : '';
    if (!name || name.length > 200) return c.json({ error: 'Enter their name.' }, 400);
    if (!isEmail(email)) return c.json({ error: 'Enter a valid email address.' }, 400);
    if (!role) return c.json({ error: 'Choose doctor or staff.' }, 400);
    if (await accountEmailTaken(c, email)) return c.json({ error: 'Someone already has an account with this email.' }, 409);

    let practiceId = d.practiceId;
    let practiceName: string;
    if (!practiceId) {
      practiceId = uuid();
      practiceName = typeof body.practice_name === 'string' && body.practice_name.trim() ? body.practice_name.trim().slice(0, 200) : `${d.name}'s practice`;
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO practices (id, name, created_at) VALUES (?, ?, ?)`).bind(practiceId, practiceName, nowIso()),
        c.env.DB.prepare(`UPDATE doctors SET practice_id = ? WHERE id = ?`).bind(practiceId, d.doctorId),
      ]);
    } else {
      practiceName = (await c.env.DB.prepare(`SELECT name FROM practices WHERE id = ?`).bind(practiceId).first<{ name: string }>())?.name ?? 'your practice';
    }

    const token = randomToken();
    await c.env.DB.prepare(
      `INSERT INTO account_invites (id, practice_id, name, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(await sha256Hex(token), practiceId, name, email, role, d.doctorId, nowIso(), hoursFromNow(INVITE_DAYS * 24)).run();
    try {
      await sendEmail(c.env, {
        to: email,
        subject: `${d.name} added you to ${practiceName} on Aurelius Code`,
        text:
          `Hello ${name},\n\n${d.name} has added you to ${practiceName} on Aurelius Code, as ${role === 'doctor' ? 'a doctor' : 'a member of staff'}.\n\n` +
          `Choose your password here (the link works for ${INVITE_DAYS} days):\n${c.env.APP_ORIGIN}/doctor/join/${token}\n\n` +
          `If you weren't expecting this, you can ignore this email.`,
      });
    } catch (err) {
      console.error('team invite email failed', err);
      return c.json({ error: "The invitation was saved, but the email couldn't be sent. Try again shortly." }, 502);
    }
    return c.json({ invited: true, practice: { id: practiceId, name: practiceName } }, 201);
  });

  app.post('/team/invites/:id/cancel', async (c) => {
    const d = c.get('doctor');
    if (d.role !== 'doctor' || !d.practiceId) return c.json({ error: 'Not found.' }, 404);
    const done = await c.env.DB.prepare(`UPDATE account_invites SET revoked_at = ? WHERE practice_id = ? AND substr(id, 1, 16) = ? AND used_at IS NULL AND revoked_at IS NULL`)
      .bind(nowIso(), d.practiceId, c.req.param('id')).run();
    return done.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Not found.' }, 404);
  });

  // Turns off someone's access (they leave the practice). Their invites and
  // records stay.
  app.post('/team/:id/disable', async (c) => {
    const d = c.get('doctor');
    if (d.role !== 'doctor' || !d.practiceId) return c.json({ error: 'Only doctors can change the team.' }, 403);
    if (c.req.param('id') === d.doctorId) return c.json({ error: "You can't turn off your own access." }, 400);
    const now = nowIso();
    const done = await c.env.DB.prepare(`UPDATE doctors SET disabled_at = ? WHERE id = ? AND practice_id = ? AND disabled_at IS NULL`)
      .bind(now, c.req.param('id'), d.practiceId).run();
    if (!done.meta.changes) return c.json({ error: 'Not found.' }, 404);
    await c.env.DB.prepare(`UPDATE doctor_sessions SET revoked_at = ? WHERE doctor_id = ? AND revoked_at IS NULL`).bind(now, c.req.param('id')).run();
    return c.json({ ok: true });
  });

  app.post('/team/practice', async (c) => {
    const d = c.get('doctor');
    if (d.role !== 'doctor' || !d.practiceId) return c.json({ error: 'Only doctors in a practice can change its settings.' }, 403);
    const body = await readJson(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length > 200) return c.json({ error: 'That name is too long.' }, 400);
    if (body.require_mfa === true && !d.mfaEnabled) return c.json({ error: 'Turn on two-step sign-in for yourself first.' }, 409);
    await c.env.DB.prepare(`UPDATE practices SET name = COALESCE(NULLIF(?, ''), name), require_mfa = COALESCE(?, require_mfa) WHERE id = ?`)
      .bind(name, typeof body.require_mfa === 'boolean' ? (body.require_mfa ? 1 : 0) : null, d.practiceId).run();
    return c.json({ ok: true });
  });
}

async function passwordMatches(c: Ctx, doctorId: string, password: unknown): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const row = await c.env.DB.prepare(`SELECT password_hash FROM doctors WHERE id = ?`).bind(doctorId).first<{ password_hash: string }>();
  return !!row && (await verifyPassword(password, row.password_hash));
}
