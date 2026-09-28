import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, TURNSTILE_OK, captureEmails, env } from './helpers';

let mail: ReturnType<typeof captureEmails>;
beforeEach(() => { mail = captureEmails(); });
afterEach(() => mail.restore());

const good = (over: Record<string, unknown> = {}) => ({
  name: 'Dana Reyes', email: 'dana@clinic.example', organization: 'Reyes Orthopedics',
  topic: 'Subscription: Private Practice', message: 'We would like a demo.', turnstileToken: TURNSTILE_OK, ...over,
});

describe('contact form', () => {
  it('stores the message and emails it to CONTACT_TO with Reply-To set to the sender', async () => {
    const res = await new Client().post('/api/public/contact', good());
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT * FROM contact_messages WHERE email = ?`).bind('dana@clinic.example').first<any>();
    expect(row).toMatchObject({ name: 'Dana Reyes', organization: 'Reyes Orthopedics', message: 'We would like a demo.' });
    expect(row.emailed_at).toMatch(/Z$/);
    const sent = mail.lastTo('owner@app.test')!;
    expect(sent.replyTo).toBe('dana@clinic.example');
    expect(sent.subject).toContain('Subscription: Private Practice');
    expect(sent.text).toContain('We would like a demo.');
  });

  it('rejects a missing name, a bad email, an overlong message and a failed bot check', async () => {
    const c = new Client();
    expect((await c.post('/api/public/contact', good({ name: '' }))).status).toBe(400);
    expect((await c.post('/api/public/contact', good({ email: 'not-an-email' }))).status).toBe(400);
    expect((await c.post('/api/public/contact', good({ message: 'x'.repeat(5001) }))).status).toBe(400);
    expect((await c.post('/api/public/contact', good({ turnstileToken: 'bad' }))).status).toBe(400);
    expect(mail.sent.filter((e) => e.to === 'owner@app.test')).toHaveLength(0);
  });

  it('limits how many messages one address can send', async () => {
    const c = new Client();
    for (let i = 0; i < 5; i++) expect((await c.post('/api/public/contact', good({ email: `x${i}@clinic.example` }))).status).toBe(200);
    expect((await c.post('/api/public/contact', good())).status).toBe(429);
  });
});
