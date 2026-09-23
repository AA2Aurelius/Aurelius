export interface Env {
  DB: D1Database;
  VIDEOS: R2Bucket;

  // --- secrets (wrangler secret put NAME) ---
  OTP_SECRET: string;          // HMAC key for one-time code hashes
  SIGNING_KEY_JWK: string;     // Ed25519 private key (JWK JSON) that signs certificates
  RESEND_API_KEY?: string;     // email delivery; may be unset only in development
  TURNSTILE_SECRET_KEY?: string; // bot check before emailing a code; may be unset only in development

  // --- vars (wrangler.toml) ---
  ENVIRONMENT: string;         // "production" | "development" | "test"
  APP_ORIGIN: string;          // e.g. https://app.aurelius.example -- frontend and API share it
  EMAIL_FROM: string;
  LINK_EXPIRY_HOURS: string;
  REMINDER_HOURS_BEFORE_EXPIRY: string;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Unguessable bearer token (link tokens, session tokens). 32 random bytes.
export function randomToken(): string {
  return base64url(randomBytes(32));
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// Constant-time comparison of two equal-length strings.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Deterministic JSON: object keys sorted, no whitespace. Used for anything
// that gets hashed or signed, so the same data always yields the same bytes.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) throw new Error('canonicalJson: undefined is not allowed');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`);
  return `{${entries.join(',')}}`;
}

// ---- time: always ISO-8601 UTC with milliseconds ----

export function nowIso(): string {
  return new Date().toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

export function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function hoursUntil(isoTime: string): number {
  return (new Date(isoTime).getTime() - Date.now()) / 3600_000;
}

export function secondsSince(isoTime: string): number {
  return (Date.now() - new Date(isoTime).getTime()) / 1000;
}

// ---- misc ----

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const picked = parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]];
  return picked.map((p) => `${p[0].toUpperCase()}.`).join(' ');
}

export function isEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function clientIp(req: Request): string | null {
  return req.headers.get('CF-Connecting-IP');
}
