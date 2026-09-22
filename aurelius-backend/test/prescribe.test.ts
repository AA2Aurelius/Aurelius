import { describe, expect, it } from 'vitest';
import { captureEmails, env, events, loginDoctor, seedDoctor, seedProcedure } from './helpers';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('prescribe', () => {
  it('creates the prescription, progress rows and first audit event, and emails the link', async () => {
    const emails = captureEmails();
    try {
      const client = await loginDoctor(await seedDoctor());
      const { procedureId, videoIds } = await seedProcedure(3);
      const res = await client.post('/api/doctor/prescribe', { patient_name: 'Jane Smith', patient_email: 'jane@mail.test', procedure_id: procedureId });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.emailSent).toBe(true);
      expect(body.watchUrl).toMatch(/^https:\/\/app\.test\/watch\/[A-Za-z0-9_-]{43}$/);

      const rows = await env.DB.prepare(`SELECT video_id FROM video_progress WHERE prescription_id = ?`).bind(body.prescriptionId).all();
      expect(rows.results.map((r: any) => r.video_id).sort()).toEqual([...videoIds].sort());
      expect((await events(body.prescriptionId)).map((e) => e.event_type)).toEqual(['prescribed', 'link_sent']);
      expect(emails.lastTo('jane@mail.test')!.text).toContain(body.watchUrl);
    } finally {
      emails.restore();
    }
  });

  it('validates before writing anything', async () => {
    const client = await loginDoctor(await seedDoctor());
    const { procedureId } = await seedProcedure(1);
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prescriptions`).first<{ n: number }>();

    expect((await client.post('/api/doctor/prescribe', { patient_name: 'A', patient_email: 'nope', procedure_id: procedureId })).status).toBe(400);
    expect((await client.post('/api/doctor/prescribe', { patient_name: '', patient_email: 'a@b.test', procedure_id: procedureId })).status).toBe(400);
    expect((await client.post('/api/doctor/prescribe', { patient_name: 'A', patient_email: 'a@b.test', procedure_id: 'missing' })).status).toBe(404);

    const { procedureId: empty } = await seedProcedure(0);
    expect((await client.post('/api/doctor/prescribe', { patient_name: 'A', patient_email: 'a@b.test', procedure_id: empty })).status).toBe(400);

    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prescriptions`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('rolls back the whole prescription if any insert fails', async () => {
    const client = await loginDoctor(await seedDoctor());
    const { procedureId } = await seedProcedure(2);
    // Make the progress-row insert fail midway through the batch.
    await env.DB.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON video_progress BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    try {
      const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prescriptions`).first<{ n: number }>();
      const res = await client.post('/api/doctor/prescribe', { patient_name: 'A', patient_email: 'a@b.test', procedure_id: procedureId });
      expect(res.status).toBe(500);
      const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prescriptions`).first<{ n: number }>();
      expect(after!.n).toBe(before!.n);
    } finally {
      await env.DB.exec(`DROP TRIGGER fail_progress`);
    }
  });

  it('writes every timestamp in one ISO-8601 UTC format', async () => {
    const client = await loginDoctor(await seedDoctor());
    const { procedureId } = await seedProcedure(1);
    const res = await client.post('/api/doctor/prescribe', { patient_name: 'A', patient_email: 'a@b.test', procedure_id: procedureId });
    const { prescriptionId } = (await res.json()) as any;
    const p = await env.DB.prepare(`SELECT created_at, expires_at FROM prescriptions WHERE id = ?`).bind(prescriptionId).first<any>();
    expect(p.created_at).toMatch(ISO);
    expect(p.expires_at).toMatch(ISO);
    for (const e of await events(prescriptionId)) expect(e.server_time).toMatch(ISO);
    const d = await env.DB.prepare(`SELECT created_at FROM procedures WHERE id = ?`).bind(procedureId).first<any>();
    expect(d.created_at).toMatch(ISO);
    // The SQL default produces the same format as application code.
    const def = await env.DB.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS t`).first<any>();
    expect(def.t).toMatch(ISO);
  });
});
