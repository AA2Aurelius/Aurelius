import { CHAIN_ALGORITHM, logEvent, verifyChain } from './audit';
import { Env, base64url, canonicalJson, fromBase64url, maskEmail, nowIso, randomBytes, sha256Hex, uuid } from './lib';

// Certificates are issued once per prescription, signed with Ed25519, and
// never changed. Anyone holding the public key (GET /verify/public-key) can
// check a certificate's signature without trusting this server.

// Until full server-side watch-time verification lands, completion rests
// on a time-since-first-stream check only, and every certificate says so.
export const VERIFICATION_LEVEL = 'interim-time-check';

// ---------------------------------------------------------------- signing

interface SigningKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  keyId: string;
}

let cachedKeys: { source: string; keys: Promise<SigningKeys> } | null = null;

async function loadKeys(jwkJson: string): Promise<SigningKeys> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) throw new Error('SIGNING_KEY_JWK must be an Ed25519 private JWK');
  // Import only the key material: generators disagree on the optional
  // "alg" member ("EdDSA" vs "Ed25519") and the Workers runtime rejects one.
  const publicJwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', { ...publicJwk, d: jwk.d }, { name: 'Ed25519' }, false, ['sign']),
    crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, ['verify']),
  ]);
  return { privateKey, publicKey, publicJwk, keyId: (await sha256Hex(jwk.x)).slice(0, 16) };
}

export function signingKeys(env: Env): Promise<SigningKeys> {
  if (!env.SIGNING_KEY_JWK) throw new Error('SIGNING_KEY_JWK is not configured');
  if (cachedKeys?.source !== env.SIGNING_KEY_JWK) {
    cachedKeys = { source: env.SIGNING_KEY_JWK, keys: loadKeys(env.SIGNING_KEY_JWK) };
  }
  return cachedKeys.keys;
}

async function sign(env: Env, payload: string): Promise<{ signature: string; keyId: string }> {
  const keys = await signingKeys(env);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new TextEncoder().encode(payload));
  return { signature: base64url(sig), keyId: keys.keyId };
}

export async function signatureValid(env: Env, payload: string, signature: string): Promise<boolean> {
  const keys = await signingKeys(env);
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, keys.publicKey, fromBase64url(signature), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

// ------------------------------------------------------ verification code

// Crockford base32: no I, L, O or U, so codes survive being read aloud or
// retyped from paper. 12 characters = 60 random bits.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newVerificationCode(): string {
  return Array.from(randomBytes(12), (b) => CROCKFORD[b & 31]).join('');
}

export function formatVerificationCode(code: string): string {
  return `AUR-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

// Accepts "AUR-7K3M-QX9P-2WHD", "aur7k3mqx9p2whd", etc. Returns the stored
// form, or null if it can't be a valid code.
export function normalizeVerificationCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('AUR')) s = s.slice(3);
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(s) ? s : null;
}

// ------------------------------------------------------------ certificate

export interface CertificatePayload {
  version: 1;
  certificate_id: string;
  verification_code: string;
  prescription_id: string;
  issued_at: string;
  completed_at: string;
  verification_level: string;
  patient: {
    name: string;
    identity_verification: { method: 'email_one_time_code'; destination: string; verified_at: string };
  };
  procedure: { id: string; name: string };
  prescribed_by: { doctor_id: string; name: string };
  videos: Array<{
    order: number;
    video_id: string;
    title: string;
    duration_seconds: number;
    started_at: string;
    completed_at: string;
    seek_attempts: number;
    pause_count: number;
  }>;
  total_seek_attempts: number;
  audit_log: { algorithm: string; event_count: number; head_hash: string };
  signature: { algorithm: 'Ed25519'; key_id: string };
}

export interface CertificateRow {
  id: string;
  prescription_id: string;
  verification_code: string;
  payload: string;
  signature: string;
  key_id: string;
  issued_at: string;
}

export async function getCertificateRow(env: Env, prescriptionId: string): Promise<CertificateRow | null> {
  return env.DB.prepare(`SELECT * FROM certificates WHERE prescription_id = ?`).bind(prescriptionId).first<CertificateRow>();
}

// Issues the certificate if every video in the set is complete. Idempotent:
// returns the existing certificate if one was already issued, or null if
// the set isn't finished yet.
export async function issueCertificateIfComplete(env: Env, prescriptionId: string): Promise<CertificateRow | null> {
  const existing = await getCertificateRow(env, prescriptionId);
  if (existing) return existing;

  const p = await env.DB.prepare(
    `SELECT pr.id, pr.patient_name, pr.patient_email, pr.procedure_id, proc.name AS procedure_name, d.id AS doctor_id, d.name AS doctor_name
     FROM prescriptions pr
     JOIN procedures proc ON proc.id = pr.procedure_id
     JOIN doctors d ON d.id = pr.doctor_id
     WHERE pr.id = ?`
  ).bind(prescriptionId).first<any>();
  if (!p) return null;

  const { results: progress } = await env.DB.prepare(
    `SELECT v.id AS video_id, v.title, v.order_index, v.duration_seconds, vp.started_at, vp.completed_at, vp.seek_attempts, vp.pause_count
     FROM video_progress vp JOIN videos v ON v.id = vp.video_id
     WHERE vp.prescription_id = ? ORDER BY v.order_index`
  ).bind(prescriptionId).all<any>();
  if (progress.length === 0 || progress.some((r) => !r.completed_at)) return null;

  const firstVerification = await env.DB.prepare(
    `SELECT created_at FROM patient_sessions WHERE prescription_id = ? ORDER BY created_at LIMIT 1`
  ).bind(prescriptionId).first<{ created_at: string }>();
  if (!firstVerification) throw new Error(`prescription ${prescriptionId} completed without a verified patient session`);

  const chain = await verifyChain(env, prescriptionId);
  if (!chain.ok) throw new Error(`refusing to certify prescription ${prescriptionId}: audit log ${chain.error}`);

  const keys = await signingKeys(env);
  const id = uuid();
  const code = newVerificationCode();
  const issuedAt = nowIso();
  const payload: CertificatePayload = {
    version: 1,
    certificate_id: id,
    verification_code: formatVerificationCode(code),
    prescription_id: prescriptionId,
    issued_at: issuedAt,
    completed_at: progress.reduce((latest, r) => (r.completed_at > latest ? r.completed_at : latest), progress[0].completed_at),
    verification_level: VERIFICATION_LEVEL,
    patient: {
      name: p.patient_name,
      identity_verification: { method: 'email_one_time_code', destination: maskEmail(p.patient_email), verified_at: firstVerification.created_at },
    },
    procedure: { id: p.procedure_id, name: p.procedure_name },
    prescribed_by: { doctor_id: p.doctor_id, name: p.doctor_name },
    videos: progress.map((r) => ({
      order: r.order_index,
      video_id: r.video_id,
      title: r.title,
      duration_seconds: r.duration_seconds,
      started_at: r.started_at,
      completed_at: r.completed_at,
      seek_attempts: r.seek_attempts,
      pause_count: r.pause_count,
    })),
    total_seek_attempts: progress.reduce((sum, r) => sum + r.seek_attempts, 0),
    audit_log: { algorithm: CHAIN_ALGORITHM, event_count: chain.count, head_hash: chain.headHash },
    signature: { algorithm: 'Ed25519', key_id: keys.keyId },
  };
  const payloadJson = canonicalJson(payload);
  const { signature, keyId } = await sign(env, payloadJson);

  // If two requests race to issue, the UNIQUE(prescription_id) constraint
  // lets exactly one win; the other returns the winner's certificate.
  const inserted = await env.DB.prepare(
    `INSERT INTO certificates (id, prescription_id, verification_code, payload, signature, key_id, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prescription_id) DO NOTHING`
  ).bind(id, prescriptionId, code, payloadJson, signature, keyId, issuedAt).run();
  if (inserted.meta.changes === 1) {
    await logEvent(env, { prescriptionId, type: 'certificate_issued', meta: { certificate_id: id, covers_events: chain.count, head_hash: chain.headHash } });
  }
  return getCertificateRow(env, prescriptionId);
}

export interface CertificateCheck {
  valid: boolean;
  problems: string[];
  payload: CertificatePayload | null;
}

// Full integrity check of a stored certificate: signature, internal
// consistency, and that the audit log it pins is still intact.
export async function checkCertificate(env: Env, row: CertificateRow): Promise<CertificateCheck> {
  const problems: string[] = [];
  let payload: CertificatePayload | null = null;

  if (!(await signatureValid(env, row.payload, row.signature))) problems.push('signature does not match');
  try {
    payload = JSON.parse(row.payload) as CertificatePayload;
  } catch {
    problems.push('payload is not valid JSON');
  }

  if (payload) {
    if (payload.certificate_id !== row.id) problems.push('certificate id mismatch');
    if (payload.prescription_id !== row.prescription_id) problems.push('prescription mismatch');
    if (normalizeVerificationCode(payload.verification_code) !== row.verification_code) problems.push('verification code mismatch');
    const chain = await verifyChain(env, row.prescription_id, payload.audit_log.event_count);
    if (!chain.ok) problems.push(`audit log: ${chain.error}`);
    else if (chain.headHash !== payload.audit_log.head_hash) problems.push('audit log head hash mismatch');
  }

  return { valid: problems.length === 0, problems, payload };
}
