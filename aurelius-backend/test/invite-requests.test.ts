import { describe, expect, it } from 'vitest';
import { sendRequestedInvites } from '../src/inviteRequests';
import { Client, captureEmails, env, seedDoctor } from './helpers';

// What `npm run create-doctor -- --invite` writes.
async function queueInvite(name: string, email: string, practice = 'Smith Orthopedics', role = 'doctor') {
  const now = new Date().toISOString();
  let p = await env.DB.prepare(`SELECT id FROM practices WHERE name = ?`).bind(practice).first<{ id: string }>();
  if (!p) {
    p = { id: crypto.randomUUID() };
    await env.DB.prepare(`INSERT INTO practices (id, name, created_at) VALUES (?, ?, ?)`).bind(p.id, practice, now).run();
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO invite_requests (id, practice_id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, p.id, name, email, role, now).run();
  return { requestId: id, practiceId: p.id };
}

describe('invitations queued from the command line', () => {
  it('are emailed once; the person chooses their own password and joins the practice', async () => {
    const email = `dr-${crypto.randomUUID().slice(0, 6)}@clinic.test`;
    const { requestId, practiceId } = await queueInvite('Dr. Jane Smith', email);

    const emails = captureEmails();
    let token: string;
    try {
      await sendRequestedInvites(env);
      await sendRequestedInvites(env); // a second run must not resend
      const sent = emails.sent.filter((e) => e.to === email);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain('Smith Orthopedics');
      token = /\/doctor\/join\/([A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    } finally {
      emails.restore();
    }
    expect(await env.DB.prepare(`SELECT outcome FROM invite_requests WHERE id = ?`).bind(requestId).first()).toEqual({ outcome: 'sent' });

    const client = new Client();
    expect(await (await client.fetch(`/api/doctor/join/${token}`)).json()).toMatchObject({ name: 'Dr. Jane Smith', email, role: 'doctor', practice: 'Smith Orthopedics' });
    expect((await client.post(`/api/doctor/join/${token}`, { password: 'my own chosen password' })).status).toBe(201);
    const me: any = await (await client.fetch('/api/doctor/me')).json();
    expect(me).toMatchObject({ email, role: 'doctor', practice: { id: practiceId, name: 'Smith Orthopedics' } });

    // Signs in later with the password they chose; the link works once.
    expect((await new Client().post('/api/doctor/login', { email, password: 'my own chosen password' })).status).toBe(200);
    expect((await new Client().post(`/api/doctor/join/${token}`, { password: 'another password here' })).status).toBe(410);
  });

  it('skips an email that already has an account, and retries a failed send', async () => {
    const existing = await seedDoctor();
    const { requestId: skipped } = await queueInvite('Someone', existing.email, 'Other Practice');

    const email = `dr-${crypto.randomUUID().slice(0, 6)}@clinic.test`;
    const { requestId: retried } = await queueInvite('Dr. Retry', email, 'Retry Practice');
    const failing = captureEmails();
    const realFetch = globalThis.fetch;
    try {
      // Make Resend fail for this run.
      (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        return url.startsWith('https://api.resend.com/') ? new Response('down', { status: 500 }) : realFetch(input, init);
      };
      await sendRequestedInvites(env);
    } finally {
      (globalThis as any).fetch = realFetch;
      failing.restore();
    }
    expect(await env.DB.prepare(`SELECT outcome FROM invite_requests WHERE id = ?`).bind(skipped).first()).toEqual({ outcome: 'account already exists' });
    const afterFail = await env.DB.prepare(`SELECT sent_at, attempts FROM invite_requests WHERE id = ?`).bind(retried).first<any>();
    expect(afterFail).toMatchObject({ sent_at: null, attempts: 1 });
    // No usable link was left behind for the failed send.
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM account_invites WHERE email = ?`).bind(email).first()).toEqual({ n: 0 });

    const emails = captureEmails();
    try {
      await sendRequestedInvites(env);
      expect(emails.lastTo(email)).toBeTruthy();
      expect(emails.lastTo(existing.email)).toBeUndefined();
    } finally {
      emails.restore();
    }
  });
});
