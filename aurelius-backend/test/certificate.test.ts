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
    expect(c.verification_level).toBe('server-paced-v1');
    expect(c.version).toBe(3);
    expect(c.acknowledgment).toMatchObject({ statement_version: 1, asked_doctor_a_question: false });
    expect(c.videos[0].understanding).toEqual({ questions: 0, attempts: 0, first_try_correct: 0 });
    for (const v of c.videos) {
      expect(v.watch.credited_seconds).toBeGreaterThanOrEqual(v.duration_seconds);
      expect(v.watch.wall_seconds).toBeGreaterThanOrEqual(v.duration_seconds);
      expect(v.watch.attention_checks_passed).toBeGreaterThanOrEqual(1);
    }
    expect(c.total_seek_blocked).toBe(0);
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

  it('detects edited playback evidence (heartbeats or chunk serves)', async () => {
    for (const table of ['heartbeats', 'segment_serves'] as const) {
      const s = await certified();
      const col = table === 'heartbeats' ? 'position_ms = position_ms + 1' : "first_served_at = '2000-01-01T00:00:00.000Z'";
      await env.DB.exec(`DROP TRIGGER ${table}_no_update`);
      try {
        await env.DB.prepare(`UPDATE ${table} SET ${col} WHERE playback_id = ?`).bind(s.cert.certificate.videos[0].watch.playback_id).run();
        expect(((await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any).status, table).toBe('tampered');
        const doctorView = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate`)).json()) as any;
        expect(doctorView.integrity.problems.join(' '), table).toMatch(/video 1: (heartbeat|chunk-serve) records changed/);
      } finally {
        await env.DB.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`);
      }
    }
  });

  it('events logged after issuance do not invalidate the certificate', async () => {
    const s = await certified();
    // Rewatching is allowed; its events extend the chain past what the certificate covers.
    await s.patient.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/seek-attempt`, { from: 1, to: 2 });
    expect(((await (await new Client().fetch(`/api/verify/${s.cert.verificationCode}`)).json()) as any).status).toBe('valid');
  });

  it('stays reachable for the patient after the link expires', async () => {
    const s = await certified();
    await env.DB.prepare(`UPDATE prescriptions SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), s.prescriptionId).run();
    expect((await s.patient.fetch(`/api/watch/${s.token}/certificate`)).status).toBe(200);
    // ...but watching is over.
    expect((await s.patient.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/playback`)).status).toBe(410);
  });
});

describe('replacing the signing key', () => {
  it('keeps certificates signed with the earlier key verifiable, and signs new ones with the new key', async () => {
    const before = await certified();
    const oldKeyId = before.cert.certificate.signature.key_id;
    const original = env.SIGNING_KEY_JWK;
    const { privateKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const { kty, crv, x, d } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
    env.SIGNING_KEY_JWK = JSON.stringify({ kty, crv, x, d });
    try {
      const anyone = new Client();
      // The certificate signed before the change still checks out, both ways.
      const code = before.cert.verificationCode;
      expect(await (await anyone.fetch(`/api/verify/${code}`)).json()).toMatchObject({ status: 'valid' });
      const posted = (await (await anyone.post('/api/verify', { payload: before.cert.payload, signature: before.cert.signature })).json()) as any;
      expect(posted).toEqual({ signature_valid: true, matches_record: true });

      // New certificates use the new key; the public key list shows both.
      const after = await certified();
      expect(after.cert.certificate.signature.key_id).not.toBe(oldKeyId);
      expect(await (await anyone.fetch(`/api/verify/${after.cert.verificationCode}`)).json()).toMatchObject({ status: 'valid' });
      const pk = (await (await anyone.fetch('/api/verify/public-key')).json()) as any;
      expect(pk.key_id).toBe(after.cert.certificate.signature.key_id);
      expect(pk.keys.map((k: any) => k.key_id)).toEqual(expect.arrayContaining([oldKeyId, pk.key_id]));
    } finally {
      env.SIGNING_KEY_JWK = original;
    }
  });

  it('rejects a signature made by a key it has never seen', async () => {
    const s = await certified();
    const { privateKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const forged = JSON.parse(s.cert.payload);
    forged.signature.key_id = 'ffffffffffffffff';
    const payload = JSON.stringify(forged);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(payload)));
    const b64 = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = (await (await new Client().post('/api/verify', { payload, signature: b64 })).json()) as any;
    expect(res.signature_valid).toBe(false);
  });
});
