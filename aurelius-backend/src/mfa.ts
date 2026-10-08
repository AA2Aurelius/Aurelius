import { Env, base64url, fromBase64url, randomBytes, sha256Hex, timingSafeEqual } from './lib';

// Two-step sign-in with an authenticator app (TOTP, RFC 6238: SHA-1,
// 30-second steps, 6 digits, the format every authenticator app reads).
// Secrets are stored encrypted (AES-GCM, key derived from OTP_SECRET), and
// each time-step can be used once, so a code seen over someone's shoulder
// can't be replayed.

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'Aurelius Code';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secret: string, accountEmail: string): string {
  const label = encodeURIComponent(`${ISSUER}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 15;
  const n = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

// Accepts the current code or one a step either side (clock drift), but
// never a step at or before `lastStep`. Returns the step it matched.
export async function verifyTotp(secret: string, code: string, lastStep: number | null): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(await totpAt(secret, step), code)) return step;
  }
  return null;
}

// ------------------------------------------------------------- encryption

async function secretKey(env: Env): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`aurelius-totp-v1:${env.OTP_SECRET}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env: Env, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), new TextEncoder().encode(secret));
  return `v1.${base64url(iv)}.${base64url(ct)}`;
}

export async function decryptSecret(env: Env, stored: string): Promise<string> {
  const [v, iv, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unknown secret format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv) }, await secretKey(env), fromBase64url(ct));
  return new TextDecoder().decode(pt);
}

// --------------------------------------------------------- recovery codes

// Ten one-time codes like "K7QM-2XWD", for when the phone is lost.
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = base32Encode(randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);
}
