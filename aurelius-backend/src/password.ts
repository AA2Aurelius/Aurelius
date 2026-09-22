import { base64url, fromBase64url, randomBytes, timingSafeEqual } from './lib';

// PBKDF2-SHA256 via WebCrypto. 100,000 iterations is the maximum the Workers
// runtime allows. Format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
// scripts/create-doctor.mjs produces the same format with Node's crypto.
export const PBKDF2_ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS || !salt || !hash) {
    return false;
  }
  const derived = await derive(password, fromBase64url(salt), iterations);
  return timingSafeEqual(base64url(derived), hash);
}

// Checked against when the email is unknown, so a login attempt takes the
// same time whether or not the account exists.
export const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$100000$c2FsdHNhbHRzYWx0c2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI';
