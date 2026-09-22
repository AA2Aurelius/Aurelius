import { describe, expect, it } from 'vitest';
import { Client, env, loginDoctor, prescribe, seedDoctor } from './helpers';

describe('doctor authentication', () => {
  it('rejects every doctor route without a session, even with a forged X-Doctor-Id', async () => {
    const doctor = await seedDoctor();
    const stranger = new Client();
    for (const path of ['/api/doctor/patients', '/api/doctor/procedures', '/api/doctor/me']) {
      const res = await stranger.fetch(path, { headers: { 'X-Doctor-Id': doctor.id } });
      expect(res.status, path).toBe(401);
    }
    const res = await stranger.post('/api/doctor/prescribe', { patient_name: 'x', patient_email: 'x@y.test', procedure_id: 'p' }, { 'X-Doctor-Id': doctor.id });
    expect(res.status).toBe(401);
  });

  it('signs in with the right password and sets a hardened session cookie', async () => {
    const doctor = await seedDoctor();
    const client = new Client();
    const res = await client.post('/api/doctor/login', { email: doctor.email.toUpperCase(), password: doctor.password });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-aur_ds='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);

    const me = await client.fetch('/api/doctor/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).id).toBe(doctor.id);

    // Only the token's hash is stored.
    const token = client.cookies.get('__Host-aur_ds')!;
    const stored = await env.DB.prepare(`SELECT COUNT(*) AS n FROM doctor_sessions WHERE id = ?`).bind(token).first<{ n: number }>();
    expect(stored!.n).toBe(0);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const doctor = await seedDoctor();
    const a = await new Client().post('/api/doctor/login', { email: doctor.email, password: 'wrong' });
    const b = await new Client().post('/api/doctor/login', { email: 'nobody@clinic.test', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it('locks an account after 5 failed attempts, even for the right password', async () => {
    const doctor = await seedDoctor();
    for (let i = 0; i < 5; i++) {
      expect((await new Client().post('/api/doctor/login', { email: doctor.email, password: `wrong-${i}` })).status).toBe(401);
    }
    const res = await new Client().post('/api/doctor/login', { email: doctor.email, password: doctor.password });
    expect(res.status).toBe(429);
  });

  it('ends the session on logout', async () => {
    const client = await loginDoctor(await seedDoctor());
    const saved = new Map(client.cookies);
    expect((await client.post('/api/doctor/logout')).status).toBe(200);
    client.cookies = saved; // replaying the old cookie must not work
    expect((await client.fetch('/api/doctor/me')).status).toBe(401);
  });

  it('expires a session after 30 minutes idle', async () => {
    const client = await loginDoctor(await seedDoctor());
    await env.DB.prepare(`UPDATE doctor_sessions SET last_seen_at = ?`).bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
    expect((await client.fetch('/api/doctor/me')).status).toBe(401);
  });

  it('rejects a disabled doctor', async () => {
    const doctor = await seedDoctor();
    const client = await loginDoctor(doctor);
    await env.DB.prepare(`UPDATE doctors SET disabled_at = ? WHERE id = ?`).bind(new Date().toISOString(), doctor.id).run();
    expect((await client.fetch('/api/doctor/me')).status).toBe(401);
  });

  it('rejects state-changing requests from another origin', async () => {
    const doctor = await seedDoctor();
    const res = await new Client().post('/api/doctor/login', { email: doctor.email, password: doctor.password }, { Origin: 'https://evil.test' });
    expect(res.status).toBe(403);
  });
});

describe('patient link leak', () => {
  it('never returns link tokens and only shows the signed-in doctor their own patients', async () => {
    const a = await prescribe();
    const b = await prescribe();

    const res = await a.doctorClient.fetch('/api/doctor/patients');
    const list = (await res.json()) as any[];
    expect(list.map((p) => p.id)).toEqual([a.prescriptionId]);
    expect(JSON.stringify(list)).not.toContain(a.token);
    expect(list[0]).not.toHaveProperty('link_token');
    expect(list[0]).not.toHaveProperty('link_token_hash');

    expect((await a.doctorClient.fetch(`/api/doctor/prescriptions/${b.prescriptionId}`)).status).toBe(404);
    expect((await a.doctorClient.fetch(`/api/doctor/prescriptions/${b.prescriptionId}/certificate`)).status).toBe(404);
    expect((await a.doctorClient.fetch(`/api/doctor/prescriptions/${a.prescriptionId}`)).status).toBe(200);
  });

  it('does not store the link token in the database', async () => {
    const s = await prescribe();
    const row = await env.DB.prepare(`SELECT * FROM prescriptions WHERE id = ?`).bind(s.prescriptionId).first<any>();
    expect(JSON.stringify(row)).not.toContain(s.token);
  });
});
