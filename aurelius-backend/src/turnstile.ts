import { Env } from './lib';

// Cloudflare Turnstile bot check, used before a one-time code is emailed.
// Without a secret key the check is skipped, which is allowed in
// development alone -- production fails closed.
export async function turnstilePasses(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) {
    if (env.ENVIRONMENT !== 'development') throw new Error('TURNSTILE_SECRET_KEY is not configured');
    return true;
  }
  if (typeof token !== 'string' || !token || token.length > 2048) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Turnstile verification failed: ${res.status}`);
  const body = (await res.json()) as { success?: boolean };
  return body.success === true;
}
