import { describe, expect, it } from 'vitest';
import { Client, captureEmails, env, events, loginDoctor, prescribe, seedDoctor, verifiedPatient, watchAndComplete } from './helpers';

async function resend(s: Awaited<ReturnType<typeof prescribe>>, body: unknown = {}) {
  const emails = captureEmails();
  try {
    const res = await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/resend`, body);
    return { res, body: (await res.json()) as any, emails: emails.sent };
  } finally {
    emails.restore();
  }
}

describe('resend', () => {
  it('issues a new link, revokes the old one and ends its sessions, in one step', async () => {
    const s = await prescribe();
    const patient = await verifiedPatient(s.token, s.patientEmail);

    const { res, body, emails } = await resend(s);
    expect(res.status).toBe(201);
    expect(body.replaces).toBe(s.prescriptionId);
    expect(body.prescriptionId).not.toBe(s.prescriptionId);
    const newToken = body.watchUrl.split('/watch/')[1];
    expect(newToken).not.toBe(s.token);
    expect(emails.map((e) => e.to)).toEqual([s.patientEmail]);
    expect(emails[0].text).toContain(body.watchUrl);
    expect(emails[0].text).toContain('earlier link no longer works');

    // Old link and its verified session are dead.
    expect((await patient.fetch(`/api/watch/${s.token}`)).status).toBe(410);
    expect((await patient.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/playback`)).status).toBe(410);
    const sessions = await env.DB.prepare(`SELECT revoked_at FROM patient_sessions WHERE prescription_id = ?`).bind(s.prescriptionId).all<any>();
    expect(sessions.results.every((r) => r.revoked_at)).toBe(true);

    // New link works, with fresh progress and a fresh 48 hours.
    const fresh = await verifiedPatient(newToken, s.patientEmail);
    const view = (await (await fresh.fetch(`/api/watch/${newToken}`)).json()) as any;
    expect(view.videos.every((v: any) => !v.complete)).toBe(true);
    expect(view.hoursLeft).toBeGreaterThan(47.9);

    // Both audit chains record it, pointing at each other.
    const oldEvents = await events(s.prescriptionId);
    const replaced = oldEvents.find((e) => e.event_type === 'link_replaced');
    expect(JSON.parse(replaced.meta)).toMatchObject({ replaced_by: body.prescriptionId, was: 'active' });
    const newEvents = await events(body.prescriptionId);
    expect(newEvents[0].event_type).toBe('prescribed');
    expect(JSON.parse(newEvents[0].meta).replaces_prescription_id).toBe(s.prescriptionId);

    const old = await env.DB.prepare(`SELECT revoked_reason FROM prescriptions WHERE id = ?`).bind(s.prescriptionId).first<any>();
    expect(old.revoked_reason).toBe('resent');
  });

  it('works for an expired link, the case the spec calls out', async () => {
    const s = await prescribe();
    await env.DB.prepare(`UPDATE prescriptions SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), s.prescriptionId).run();
    const { res, body } = await resend(s);
    expect(res.status).toBe(201);
    expect(JSON.parse((await events(s.prescriptionId)).find((e) => e.event_type === 'link_replaced').meta).was).toBe('expired');
    expect((await new Client().fetch(`/api/watch/${body.watchUrl.split('/watch/')[1]}`)).status).toBe(200);
  });

  it('can send the new link to a corrected email address', async () => {
    const s = await prescribe();
    const { res, body, emails } = await resend(s, { patient_email: 'fixed@mail.test' });
    expect(res.status).toBe(201);
    expect(emails.map((e) => e.to)).toEqual(['fixed@mail.test']);
    const row = await env.DB.prepare(`SELECT patient_email FROM prescriptions WHERE id = ?`).bind(body.prescriptionId).first<any>();
    expect(row.patient_email).toBe('fixed@mail.test');
    expect((await resend(await prescribe(), { patient_email: 'not-an-email' })).res.status).toBe(400);
  });

  it('replaces a link only once, even when two resends race', async () => {
    const s = await prescribe();
    const [a, b] = await Promise.all([resend(s), resend(s)]);
    expect([a.res.status, b.res.status].sort()).toEqual([201, 409]);
    const again = await resend(s);
    expect(again.res.status).toBe(409);
    expect(again.body.replacedBy).toBeTruthy();
    const live = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prescriptions WHERE replaces_prescription_id = ?`).bind(s.prescriptionId).first<any>();
    expect(live.n).toBe(1);
  });

  it('refuses once the set is certified, and for another doctor’s patient', async () => {
    const s = await prescribe({ videos: 1 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    expect((await resend(s)).res.status).toBe(409);

    const other = await prescribe();
    const stranger = await loginDoctor(await seedDoctor());
    expect((await stranger.post(`/api/doctor/prescriptions/${other.prescriptionId}/resend`)).status).toBe(404);
    expect((await new Client().post(`/api/doctor/prescriptions/${other.prescriptionId}/resend`)).status).toBe(401);
  });

  it('shows the doctor what replaced what', async () => {
    const s = await prescribe();
    const { body } = await resend(s);
    const old = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}`)).json()) as any;
    expect(old).toMatchObject({ revoked_reason: 'resent', replaced_by: body.prescriptionId });
    const fresh = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${body.prescriptionId}`)).json()) as any;
    expect(fresh.replaces_prescription_id).toBe(s.prescriptionId);
    const list = (await (await s.doctorClient.fetch('/api/doctor/patients')).json()) as any[];
    expect(list.map((r) => r.id)).toEqual([body.prescriptionId]);
  });
});

describe('cancel', () => {
  it('revokes the link and ends verified sessions, and logs who did it and why', async () => {
    const s = await prescribe();
    const patient = await verifiedPatient(s.token, s.patientEmail);
    const res = await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`, { reason: 'Wrong patient' });
    expect(res.status).toBe(200);

    expect((await patient.fetch(`/api/watch/${s.token}`)).status).toBe(410);
    expect((await patient.post(`/api/watch/${s.token}/otp/send`, { turnstileToken: 'turnstile-ok' })).status).toBe(410);
    const cancelled = (await events(s.prescriptionId)).filter((e) => e.event_type === 'link_cancelled');
    expect(cancelled).toHaveLength(1);
    expect(JSON.parse(cancelled[0].meta)).toMatchObject({ reason: 'Wrong patient', by_doctor: s.doctor.id });
    const row = await env.DB.prepare(`SELECT revoked_at, revoked_reason FROM prescriptions WHERE id = ?`).bind(s.prescriptionId).first<any>();
    expect(row.revoked_reason).toBe('cancelled');

    // Still on the doctor's list, marked cancelled.
    const list = (await (await s.doctorClient.fetch('/api/doctor/patients')).json()) as any[];
    expect(list.find((r) => r.id === s.prescriptionId)).toMatchObject({ revoked_reason: 'cancelled' });
    expect(row.revoked_at).toMatch(/Z$/);
  });

  it('is idempotent and logs once, even under concurrent requests', async () => {
    const s = await prescribe();
    const results = await Promise.all([1, 2, 3].map(() => s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`)));
    for (const r of results) expect(r.status).toBe(200);
    const again = (await (await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`)).json()) as any;
    expect(again.alreadyCancelled).toBe(true);
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'link_cancelled')).toHaveLength(1);
  });

  it('can be followed by a resend, which keeps "cancelled" as the reason', async () => {
    const s = await prescribe();
    await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`);
    const { res } = await resend(s);
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(`SELECT revoked_reason FROM prescriptions WHERE id = ?`).bind(s.prescriptionId).first<any>();
    expect(row.revoked_reason).toBe('cancelled');
    expect(JSON.parse((await events(s.prescriptionId)).find((e) => e.event_type === 'link_replaced').meta).was).toBe('revoked:cancelled');
  });

  it('refuses once certified, so the patient keeps their certificate', async () => {
    const s = await prescribe({ videos: 1 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    expect((await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`)).status).toBe(409);
    expect((await p.fetch(`/api/watch/${s.token}/certificate`)).status).toBe(200);
  });

  it('only works for the doctor’s own patients', async () => {
    const s = await prescribe();
    const stranger = await loginDoctor(await seedDoctor());
    expect((await stranger.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`)).status).toBe(404);
    expect((await new Client().post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`)).status).toBe(401);
    expect((await new Client().fetch(`/api/watch/${s.token}`)).status).toBe(200);
  });

  it('leaves both audit chains intact', async () => {
    const { verifyChain } = await import('../src/audit');
    const s = await prescribe();
    await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/cancel`);
    const { body } = await resend(s);
    expect((await verifyChain(env, s.prescriptionId)).ok).toBe(true);
    expect((await verifyChain(env, body.prescriptionId)).ok).toBe(true);
  });
});
