import { Env } from './lib';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

// Sends via Resend. Without an API key the message is only printed, and
// that is allowed in development alone -- a production deploy with no key
// fails loudly rather than silently dropping one-time codes.
export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.ENVIRONMENT !== 'development') throw new Error('RESEND_API_KEY is not configured');
    console.log(`[dev email] to=${email.to} subject=${JSON.stringify(email.subject)}\n${email.text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
}
