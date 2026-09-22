import { describe, expect, it } from 'vitest';
import { verifyChain } from '../src/audit';
import { fromBase64url } from '../src/lib';
import { Client, env, events, prescribe, verifiedPatient, watchAndComplete } from './helpers';

async function certified() {
  const s = await prescribe();
  const p = await verifiedPatient(s.token, s.patientEmail);
  for (const v of s.videoIds) {
    const res = await watchAndComplete(p, s.token, s.prescriptionId, v);
    expect(res.status).toBe(200);
  }
  const res = await p.fetch(`/api/watch/${s.token}/certificate`);
  expect(res.status).toBe(200);
  const cert = (await res.json()) as { certificate: any; payload: string; signature: string; verificationCode: string };
  return { ...s, patient: p, cert };
}

describe('certificate', () => {
  it('is not available until every video is complete', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    expect((await p.fetch(`/api/watch/${s.token}/certificate`)).status).toBe(409);
    expect((await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate`)).status).toBe(409);
  });

  it('is issued once, with the certificate contents and a random verification code', async () => {
    const s = await certified();
    const c = s.cert.certificate;
    expect(s.cert.verificationCode).toMatch(/^AUR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(s.cert.verificationCode).not.toContain(s.prescriptionId.slice(0, 4).toUpperCase() + '-');
    expect(c.patient.name).toBe('Jane Q Smith');
    expect(c.patient.identity_verification.method).toBe('email_one_time_code');
    expect(c.patient.identity_verification.destination).toMatch(/\*\*\*@mail\.test$/);
    expect(c.videos).toHaveLength(2);
    expect(c.verification_level).toBe('interim-time-check');
    expect(c.audit_log.event_count).toBeGreaterThan(0);

    const again = (await (await s.patient.fetch(`/api/watch/${s.token}/certificate`)).json()) as any;
    expect(again.payload).toBe(s.cert.payload);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM certificates WHERE prescription_id = ?`).bind(s.prescriptionId).first<any>();
    expect(rows.n).toBe(1);
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'certificate_issued')).toHaveLength(1);
  });

  it('can be checked by anyone with the public key', async () => {
    const s = await certified();
    const keyRes = (await (await new Client().fetch('/api/verify/public-key')).json()) as any;
    expect(keyRes.jwk).not.toHaveProperty('d');
    const key = await crypto.subtle.importKey('jwk', keyRes.jwk, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64url(s.cert.signature), new TextEncoder().encode(s.cert.payload));
    expect(ok).toBe(true);
    const tampered = s.cert.payload.replace('Jane Q Smith', 'John Q Smith');
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64url(s.cert.signature), new TextEncoder().encode(tampered))).toBe(false);
  });

  it('public verify shows only status, procedure, date and initials', async () => {
    const s = await certified();
    const res = await new Client().fetch(`/api/verify/${s.cert.verificationCode}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['completed_on', 'patient_initials', 'procedure', 'status']);
    expect(body).toMatchObject({ status: 'valid', procedure: 'Hip Replacement', patient_initials: 'J. S.' });
    expect(body.completed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Typed loosely: lowercase, no dashes, O for 0 / I for 1.
    const loose = s.cert.verificationCode.toLowerCase().replace(/-/g, '').replace(/0/g, 'o').replace(/1/g, 'i');
    expect(((await (await new Client().fetch(`/api/verify/${loose}`)).json()) as any).status).toBe('valid');

    expect((await new Client().fetch(`/api/verify/AUR-0000-0000-0000`)).status).toBe(404);
    expect((await new Client().fetch(`/api/verify/garbage`)).status).toBe(404);
  });

  it('POST /verify confirms a genuine copy and rejects an edited one', async () => {
    const s = await certified();
    const good = (await (await new Client().post('/api/verify', { payload: s.cert.payload, signature: s.cert.signature })).json()) as any;
    expect(good).toEqual({ signature_valid: true, matches_record: true });
    const edited = s.cert.payload.replace('"total_seek_attempts":0', '"total_seek_attempts":1');
    expect(edited).not.toBe(s.cert.payload);
    const bad = (await (await new Client().post('/api/verify', { payload: edited, signature: s.cert.signature })).json()) as any;
    expect(bad).toEqual({ signature_valid: false, matches_record: false });
  });

  it('the database refuses to edit or delete audit events and certificates', async () => {
    const s = await certified();
    await expect(env.DB.prepare(`UPDATE progress_events SET meta = 'x' WHERE prescription_id = ?`).bind(s.prescriptionId).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare(`DELETE FROM progress_events WHERE prescription_id = ?`).bind(s.prescriptionId).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare(`UPDATE certificates SET payload = 'x' WHERE prescription_id = ?`).bind(s.prescriptionId).run()).rejects.toThrow(/immutable/);
  });

  it('detects someone with database access rewriting the audit log', async () => {
    const s = await certified();
    expect((await verifyChain(env, s.prescriptionId)).ok).toBe(true);

    // Simulate a person with direct database access: drop the guard and quietly edit history.
    await env.DB.exec(`DROP TRIGGER progress_events_no_update`);
    try {
      await env.DB.prepare(`UPDATE progress_events SET meta = '{"attempt":0}' WHERE prescription_id = ? AND event_type = 'complete'`).bind(s.prescriptionId).run();
      expect((await verifyChain(env, s.prescriptionId)).ok).toBe(false);
      const body = (await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any;
      expect(body).toEqual({ status: 'tampered' });
      const doctorView = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate`)).json()) as any;
      expect(doctorView.integrity.valid).toBe(false);
    } finally {
      await env.DB.exec(`CREATE TRIGGER progress_events_no_update BEFORE UPDATE ON progress_events BEGIN SELECT RAISE(ABORT, 'progress_events is append-only'); END;`);
    }
  });

  it('detects deleted audit events', async () => {
    const s = await certified();
    await env.DB.exec(`DROP TRIGGER progress_events_no_delete`);
    try {
      await env.DB.prepare(`DELETE FROM progress_events WHERE prescription_id = ? AND event_type = 'otp_sent'`).bind(s.prescriptionId).run();
      expect(((await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any).status).toBe('tampered');
    } finally {
      await env.DB.exec(`CREATE TRIGGER progress_events_no_delete BEFORE DELETE ON progress_events BEGIN SELECT RAISE(ABORT, 'progress_events is append-only'); END;`);
    }
  });

  it('detects an edited certificate record', async () => {
    const s = await certified();
    await env.DB.exec(`DROP TRIGGER certificates_no_update`);
    try {
      const forged = s.cert.payload.replace('Jane Q Smith', 'John Q Smith');
      await env.DB.prepare(`UPDATE certificates SET payload = ? WHERE prescription_id = ?`).bind(forged, s.prescriptionId).run();
      expect(((await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any).status).toBe('tampered');
    } finally {
      await env.DB.exec(`CREATE TRIGGER certificates_no_update BEFORE UPDATE ON certificates BEGIN SELECT RAISE(ABORT, 'certificates are immutable'); END;`);
    }
  });

  it('events logged after issuance do not invalidate the certificate', async () => {
    const s = await certified();
    // Rewatching is allowed; its events extend the chain past what the certificate covers.
    await s.patient.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/event`, { type: 'play' });
    expect(((await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any).status).toBe('valid');
  });

  it('stays reachable for the patient after the link expires', async () => {
    const s = await certified();
    await env.DB.prepare(`UPDATE prescriptions SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), s.prescriptionId).run();
    expect((await s.patient.fetch(`/api/watch/${s.token}/certificate`)).status).toBe(200);
    // ...but watching is over.
    expect((await s.patient.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).status).toBe(410);
  });
});
