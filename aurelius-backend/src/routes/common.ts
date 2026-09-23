import type { Context, MiddlewareHandler } from 'hono';
import { getCertificateRow } from '../certificate';
import { Env, hoursUntil, sha256Hex } from '../lib';
import { DoctorSession, PatientSession, getDoctorSession, getPatientSession } from '../sessions';

export interface Prescription {
  id: string;
  doctor_id: string;
  procedure_id: string;
  patient_name: string;
  patient_email: string;
  created_at: string;
  expires_at: string;
  reminder_12h_sent_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  replaces_prescription_id: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    doctor: DoctorSession;
    prescription: Prescription;
    linkExpired: boolean;   // past expires_at, but still reachable because the set is certified
    certified: boolean;
    patient: PatientSession;
  };
};

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ doctor

export const requireDoctor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getDoctorSession(c);
  if (!session) return c.json({ error: 'Not signed in.' }, 401);
  c.set('doctor', session);
  await next();
};

// ----------------------------------------------------------------- patient

// Resolves /watch/:token to a prescription. An expired link stays reachable
// only once the set is certified, so the patient can fetch their certificate.
export const loadPrescription: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'This link is invalid or has expired.' }, 410);
  const p = await c.env.DB.prepare(`SELECT * FROM prescriptions WHERE link_token_hash = ? AND revoked_at IS NULL`)
    .bind(await sha256Hex(token)).first<Prescription>();
  if (!p) return c.json({ error: 'This link is invalid or has expired.' }, 410);

  const expired = hoursUntil(p.expires_at) <= 0;
  const certified = !!(await getCertificateRow(c.env, p.id));
  if (expired && !certified) return c.json({ error: 'This link is invalid or has expired.' }, 410);

  c.set('prescription', p);
  c.set('linkExpired', expired);
  c.set('certified', certified);
  await next();
};

// Watching (streaming, events, completion) needs a live link.
export const requireActiveLink: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('linkExpired')) return c.json({ error: 'This link has expired.' }, 410);
  await next();
};

export const requirePatient: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getPatientSession(c, c.get('prescription').id);
  if (!session) return c.json({ error: 'Please verify your identity with the code we email you.' }, 401);
  c.set('patient', session);
  await next();
};

// ------------------------------------------------------------------ videos

export interface PrescribedVideo {
  progress_id: string;
  video_id: string;
  title: string;
  order_index: number;
  r2_key: string;
  duration_seconds: number;
  started_at: string | null;
  completed_at: string | null;
}

// A video counts only if it belongs to this prescription's set.
export async function getPrescribedVideo(env: Env, prescriptionId: string, videoId: string): Promise<PrescribedVideo | null> {
  return env.DB.prepare(
    `SELECT vp.id AS progress_id, v.id AS video_id, v.title, v.order_index, v.r2_key, v.duration_seconds, vp.started_at, vp.completed_at
     FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? AND vp.video_id = ?`
  ).bind(prescriptionId, videoId).first<PrescribedVideo>();
}

// Unlocked once every earlier video in the set is complete.
export async function isUnlocked(env: Env, prescriptionId: string, orderIndex: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? AND v.order_index < ? AND vp.completed_at IS NULL`
  ).bind(prescriptionId, orderIndex).first<{ n: number }>();
  return (row?.n ?? 1) === 0;
}
