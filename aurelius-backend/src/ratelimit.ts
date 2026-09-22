import { Env } from './lib';

// Fixed-window counters in D1. Coarse but sufficient for login, one-time
// codes, the public verify endpoint and client-reported playback events.

function windowStart(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % windowSeconds);
}

// Increments the counter and returns the new count for the current window.
export async function hitRateLimit(env: Env, key: string, windowSeconds: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`
  ).bind(key, windowStart(windowSeconds)).first<{ count: number }>();
  return row?.count ?? 1;
}

// Reads the current window's count without incrementing it.
export async function peekRateLimit(env: Env, key: string, windowSeconds: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_start = ?`)
    .bind(key, windowStart(windowSeconds)).first<{ count: number }>();
  return row?.count ?? 0;
}

// Convenience: increment and report whether the caller is over the limit.
export async function overLimit(env: Env, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await hitRateLimit(env, key, windowSeconds)) > limit;
}
