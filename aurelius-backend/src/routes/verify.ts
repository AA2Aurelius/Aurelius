import { Hono } from 'hono';
import { checkCertificate, normalizeVerificationCode, signatureValid, signingKeys } from '../certificate';
import { clientIp, initials } from '../lib';
import { overLimit } from '../ratelimit';
import type { AppEnv } from './common';

// Public certificate verification, mounted at /api/verify. Deliberately
// minimal: anyone holding a code learns only whether it's genuine, the
// procedure, the completion date and the patient's initials.
export const verify = new Hono<AppEnv>();

verify.use('*', async (c, next) => {
  if (await overLimit(c.env, `verify:${clientIp(c.req.raw) ?? 'unknown'}`, 20, 60)) {
    return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
  }
  await next();
});

// The key certificates are signed with, so they can be checked independently.
verify.get('/public-key', async (c) => {
  const keys = await signingKeys(c.env);
  return c.json({ algorithm: 'Ed25519', key_id: keys.keyId, jwk: keys.publicJwk });
});

verify.get('/:code', async (c) => {
  const code = normalizeVerificationCode(c.req.param('code'));
  const row = code
    ? await c.env.DB.prepare(`SELECT * FROM certificates WHERE verification_code = ?`).bind(code).first<any>()
    : null;
  if (!row) return c.json({ status: 'not_found' }, 404);

  const check = await checkCertificate(c.env, row);
  if (!check.valid || !check.payload) {
    console.error(`certificate ${row.id} failed verification: ${check.problems.join('; ')}`);
    return c.json({ status: 'tampered' });
  }
  return c.json({
    status: 'valid',
    procedure: check.payload.procedure.name,
    completed_on: check.payload.completed_at.slice(0, 10),
    patient_initials: initials(check.payload.patient.name),
  });
});

// Checks a certificate someone holds a copy of: is the signature ours, and
// is it identical to the certificate on record?
verify.post('/', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (typeof body?.payload !== 'string' || typeof body?.signature !== 'string') {
    return c.json({ error: 'Send { payload, signature } exactly as issued.' }, 400);
  }

  const signature_valid = await signatureValid(c.env, body.payload, body.signature);
  let matches_record = false;
  if (signature_valid) {
    let code: string | null = null;
    try {
      code = normalizeVerificationCode(String(JSON.parse(body.payload).verification_code ?? ''));
    } catch {}
    const row = code ? await c.env.DB.prepare(`SELECT * FROM certificates WHERE verification_code = ?`).bind(code).first<any>() : null;
    matches_record = !!row && row.payload === body.payload && (await checkCertificate(c.env, row)).valid;
  }
  return c.json({ signature_valid, matches_record });
});
