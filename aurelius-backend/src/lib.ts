export interface Env {
  DB: D1Database;
  VIDEOS: R2Bucket;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  LINK_EXPIRY_HOURS: string;
  REMINDER_HOURS_BEFORE_EXPIRY: string;
}

export function uuid(): string {
  return crypto.randomUUID();
}

// Unguessable link token -- do NOT use uuid() for this, it's not meant to
// double as a bearer secret. Use a wide random token instead.
export function linkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

export function hoursUntil(isoTime: string): number {
  return (new Date(isoTime).getTime() - Date.now()) / 3600_000;
}
