import { describe, expect, it } from 'vitest';
import { Client, captureEmails, env, events, prescribe, verifiedPatient } from './helpers';

function codeFrom(text: string) {
  return /\b(\d{6})\b/.exec(text)![1];
}

describe('patient one-time code', () => {
  it('reveals nothing about the patient or procedure before verification', async () => {
    const s = await prescribe();
    const res = await new Client().fetch(`/api/watch/${s.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.verified).toBe(false);
    expect(body.codeDestination).toMatch(/^p\*\*\*@mail\.test$/);
    const text = JSON.stringify(body);
    expect(text).not.toContain('Jane');
    expect(text).not.toContain('Hip');
    expect(body).not.toHaveProperty('videos');
  });

  it('blocks watching without a verified session', async () => {
    const s = await prescribe();
    const c = new Client();
    expect((await c.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).status).toBe(401);
    expect((await c.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/complete`)).status).toBe(401);
    expect((await c.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/seek-attempt`)).status).toBe(401);
    expect((await c.fetch(`/api/watch/${s.token}/certificate`)).status).toBe(401);
  });

  it('verifies the emailed code, opens a session and logs it', async () => {
    const s = await prescribe();
    const emails = captureEmails();
    try {
      const c = new Client();
      expect((await c.post(`/api/watch/${s.token}/otp/send`)).status).toBe(200);
      const email = emails.lastTo(s.patientEmail)!;
      const res = await c.post(`/api/watch/${s.token}/otp/verify`, { code: codeFrom(email.text) });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().some((h) => h.startsWith('__Host-aur_ps=') && /HttpOnly/i.test(h))).toBe(true);

      const view = (await (await c.fetch(`/api/watch/${s.token}`)).json()) as any;
      expect(view.verified).toBe(true);
      expect(view.patientName).toBe('Jane Q Smith');
      expect(view.videos.map((v: any) => v.unlocked)).toEqual([true, false]);

      const types = (await events(s.prescriptionId)).map((e) => e.event_type);
      expect(types).toContain('otp_sent');
      expect(types).toContain('otp_verified');
      // The code itself is never stored.
      const otp = await env.DB.prepare(`SELECT * FROM patient_otps WHERE prescription_id = ?`).bind(s.prescriptionId).first<any>();
      expect(JSON.stringify(otp)).not.toContain(codeFrom(email.text));
    } finally {
      emails.restore();
    }
  });

  it('allows 5 guesses per code, then locks it even for the right code', async () => {
    const s = await prescribe();
    const emails = captureEmails();
    try {
      const c = new Client();
      await c.post(`/api/watch/${s.token}/otp/send`);
      const code = codeFrom(emails.lastTo(s.patientEmail)!.text);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 1; i <= 5; i++) {
        const res = await c.post(`/api/watch/${s.token}/otp/verify`, { code: wrong });
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).attemptsLeft).toBe(5 - i);
      }
      expect((await c.post(`/api/watch/${s.token}/otp/verify`, { code })).status).toBe(429);
      expect((await c.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).status).toBe(401);
    } finally {
      emails.restore();
    }
  });

  it('rejects a reused code, an expired code, and resends inside the cooldown', async () => {
    const s = await prescribe();
    const emails = captureEmails();
    try {
      const c = new Client();
      await c.post(`/api/watch/${s.token}/otp/send`);
      expect((await c.post(`/api/watch/${s.token}/otp/send`)).status).toBe(429); // cooldown
      const code = codeFrom(emails.lastTo(s.patientEmail)!.text);
      expect((await c.post(`/api/watch/${s.token}/otp/verify`, { code })).status).toBe(200);
      expect((await new Client().post(`/api/watch/${s.token}/otp/verify`, { code })).status).toBe(400); // reused

      await env.DB.prepare(`UPDATE patient_otps SET created_at = ? WHERE prescription_id = ?`).bind(new Date(Date.now() - 120_000).toISOString(), s.prescriptionId).run();
      await c.post(`/api/watch/${s.token}/otp/send`);
      const code2 = codeFrom(emails.lastTo(s.patientEmail)!.text);
      await env.DB.prepare(`UPDATE patient_otps SET expires_at = ? WHERE prescription_id = ?`).bind(new Date(Date.now() - 1000).toISOString(), s.prescriptionId).run();
      expect((await new Client().post(`/api/watch/${s.token}/otp/verify`, { code: code2 })).status).toBe(400); // expired
    } finally {
      emails.restore();
    }
  });

  it("doesn't let one prescription's session open another", async () => {
    const a = await prescribe();
    const b = await prescribe();
    const patientA = await verifiedPatient(a.token, a.patientEmail);
    expect((await patientA.fetch(`/api/watch/${b.token}/video/${b.videoIds[0]}/stream`)).status).toBe(401);
    expect(((await (await patientA.fetch(`/api/watch/${b.token}`)).json()) as any).verified).toBe(false);
  });

  it('refuses expired and revoked links', async () => {
    const s = await prescribe();
    const patient = await verifiedPatient(s.token, s.patientEmail);
    await env.DB.prepare(`UPDATE prescriptions SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), s.prescriptionId).run();
    expect((await patient.fetch(`/api/watch/${s.token}`)).status).toBe(410);
    expect((await patient.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).status).toBe(410);

    const r = await prescribe();
    await env.DB.prepare(`UPDATE prescriptions SET revoked_at = ? WHERE id = ?`).bind(new Date().toISOString(), r.prescriptionId).run();
    expect((await new Client().fetch(`/api/watch/${r.token}`)).status).toBe(410);
    expect((await new Client().fetch(`/api/watch/not-a-real-token`)).status).toBe(410);
  });
});
