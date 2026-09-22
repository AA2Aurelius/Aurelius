import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Env, clientIp, nowIso, randomToken, secondsFromNow, sha256Hex } from './lib';

// Server-side sessions: the cookie holds a random token, the database holds
// only SHA-256(token). Revoking a row ends the session immediately.
// __Host- cookies must be Secure, Path=/, and carry no Domain, so they can't
// be set or overwritten by any other subdomain.

export const DOCTOR_COOKIE = '__Host-aur_ds';
export const PATIENT_COOKIE = '__Host-aur_ps';

export const DOCTOR_IDLE_SECONDS = 30 * 60;
export const DOCTOR_ABSOLUTE_SECONDS = 12 * 3600;
export const PATIENT_SESSION_SECONDS = 12 * 3600;
const LAST_SEEN_WRITE_INTERVAL_SECONDS = 60;

function setSessionCookie(c: Context, name: string, token: string, maxAgeSeconds: number) {
  setCookie(c, name, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) });
}

// ---------------------------------------------------------------- doctors

export interface DoctorSession {
  sessionId: string;
  doctorId: string;
  name: string;
  email: string;
}

export async function createDoctorSession<E extends { Bindings: Env }>(c: Context<E>, doctorId: string): Promise<void> {
  const token = randomToken();
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO doctor_sessions (id, doctor_id, created_at, last_seen_at, expires_at, client_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(await sha256Hex(token), doctorId, now, now, secondsFromNow(DOCTOR_ABSOLUTE_SECONDS), clientIp(c.req.raw), c.req.header('User-Agent') ?? null).run();
  setSessionCookie(c, DOCTOR_COOKIE, token, DOCTOR_ABSOLUTE_SECONDS);
}

export async function getDoctorSession<E extends { Bindings: Env }>(c: Context<E>): Promise<DoctorSession | null> {
  const token = getCookie(c, DOCTOR_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const now = nowIso();
  const idleCutoff = new Date(Date.now() - DOCTOR_IDLE_SECONDS * 1000).toISOString();
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.last_seen_at, d.id AS doctor_id, d.name, d.email
     FROM doctor_sessions s JOIN doctors d ON d.id = s.doctor_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at > ? AND d.disabled_at IS NULL`
  ).bind(id, now, idleCutoff).first<{ id: string; last_seen_at: string; doctor_id: string; name: string; email: string }>();
  if (!row) return null;

  // Slide the idle window, but don't write on every single request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > LAST_SEEN_WRITE_INTERVAL_SECONDS * 1000) {
    await c.env.DB.prepare(`UPDATE doctor_sessions SET last_seen_at = ? WHERE id = ?`).bind(now, id).run();
  }
  return { sessionId: id, doctorId: row.doctor_id, name: row.name, email: row.email };
}

export async function revokeDoctorSession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const token = getCookie(c, DOCTOR_COOKIE);
  if (token) {
    await c.env.DB.prepare(`UPDATE doctor_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(nowIso(), await sha256Hex(token)).run();
  }
  deleteCookie(c, DOCTOR_COOKIE, { path: '/', secure: true });
}

// --------------------------------------------------------------- patients

export interface PatientSession {
  sessionId: string;
  prescriptionId: string;
  verifiedAt: string;
}

// Called only after a one-time code has been verified. The session never
// outlives the prescription's link, unless the set is already certified
// (then the patient may still come back for their certificate).
export async function createPatientSession<E extends { Bindings: Env }>(
  c: Context<E>,
  prescription: { id: string; expires_at: string },
  otpId: string,
  certified: boolean
): Promise<string> {
  const token = randomToken();
  const sessionId = await sha256Hex(token);
  const now = nowIso();
  const cap = secondsFromNow(PATIENT_SESSION_SECONDS);
  const expiresAt = certified || cap < prescription.expires_at ? cap : prescription.expires_at;
  await c.env.DB.prepare(
    `INSERT INTO patient_sessions (id, prescription_id, otp_id, created_at, expires_at, client_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, prescription.id, otpId, now, expiresAt, clientIp(c.req.raw), c.req.header('User-Agent') ?? null).run();
  setSessionCookie(c, PATIENT_COOKIE, token, (new Date(expiresAt).getTime() - Date.now()) / 1000);
  return sessionId;
}

export async function getPatientSession<E extends { Bindings: Env }>(c: Context<E>, prescriptionId: string): Promise<PatientSession | null> {
  const token = getCookie(c, PATIENT_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT id, prescription_id, created_at FROM patient_sessions
     WHERE id = ? AND prescription_id = ? AND revoked_at IS NULL AND expires_at > ?`
  ).bind(await sha256Hex(token), prescriptionId, nowIso()).first<{ id: string; prescription_id: string; created_at: string }>();
  if (!row) return null;
  return { sessionId: row.id, prescriptionId: row.prescription_id, verifiedAt: row.created_at };
}
