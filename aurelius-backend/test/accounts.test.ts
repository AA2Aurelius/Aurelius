import { describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/mfa';
import { Client, advance, captureEmails, env, loginDoctor, seedDoctor, seedProcedure } from './helpers';

const code = (secret: string) => totpAt(secret, currentStep());

async function enableMfa(client: Client) {
  const setup: any = await (await client.post('/api/doctor/mfa/setup')).json();
  expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Aurelius%20Code/);
  expect((await client.post('/api/doctor/mfa/enable', { code: '000000' })).status).toBe(400);
  const res: any = await (await client.post('/api/doctor/mfa/enable', { code: await code(setup.secret) })).json();
  expect(res.recoveryCodes).toHaveLength(10);
  return { secret: setup.secret as string, recoveryCodes: res.recoveryCodes as string[] };
}

// Adds someone to the practice and accepts the emailed invitation.
async function join(inviter: Client, name: string, role: 'doctor' | 'staff', practice_name?: string) {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@clinic.test`;
  const emails = captureEmails();
  let token: string;
  try {
    const r = await inviter.post('/api/doctor/team/invite', { name, email, role, practice_name });
    expect(r.status).toBe(201);
    token = /\/doctor\/join\/([A-Za-z0-9_-]+)/.exec(emails.lastTo(email)!.text)![1];
  } finally {
    emails.restore();
  }
  const client = new Client();
  expect(await (await client.fetch(`/api/doctor/join/${token}`)).json()).toMatchObject({ name, email, role });
  expect((await client.post(`/api/doctor/join/${token}`, { password: 'short' })).status).toBe(400);
  expect((await client.post(`/api/doctor/join/${token}`, { password: 'a long enough password' })).status).toBe(201);
  // The link works once.
  expect((await new Client().post(`/api/doctor/join/${token}`, { password: 'a long enough password' })).status).toBe(410);
  return { client, email, password: 'a long enough password' };
}

describe('two-step sign-in', () => {
  it('asks for an authenticator code after the password, once per code', async () => {
    const doc = await seedDoctor();
    const client = await loginDoctor(doc);
    const { secret, recoveryCodes } = await enableMfa(client);

    const next = new Client();
    const step1: any = await (await next.post('/api/doctor/login', { email: doc.email, password: doc.password })).json();
    expect(step1).toEqual({ mfaRequired: true });
    expect((await next.fetch('/api/doctor/me')).status).toBe(401);
    expect((await next.post('/api/doctor/login/mfa', { code: '123456' })).status).toBe(400);

    // The code used to turn it on can't be used again; the next one works.
    advance(30_000);
    const ok = await next.post('/api/doctor/login/mfa', { code: await code(secret) });
    expect(ok.status).toBe(200);
    expect((await next.fetch('/api/doctor/me')).status).toBe(200);

    // Replaying that code in another sign-in fails.
    const other = new Client();
    await other.post('/api/doctor/login', { email: doc.email, password: doc.password });
    expect((await other.post('/api/doctor/login/mfa', { code: await code(secret) })).status).toBe(400);

    // A recovery code works once.
    const r: any = await (await other.post('/api/doctor/login/mfa', { code: recoveryCodes[0].toLowerCase() })).json();
    expect(r).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    const third = new Client();
    await third.post('/api/doctor/login', { email: doc.email, password: doc.password });
    expect((await third.post('/api/doctor/login/mfa', { code: recoveryCodes[0] })).status).toBe(400);
  });

  it('allows only 5 attempts per sign-in', async () => {
    const doc = await seedDoctor();
    await enableMfa(await loginDoctor(doc));
    const c = new Client();
    await c.post('/api/doctor/login', { email: doc.email, password: doc.password });
    for (let i = 0; i < 5; i++) expect((await c.post('/api/doctor/login/mfa', { code: '000000' })).status).toBe(400);
    expect((await c.post('/api/doctor/login/mfa', { code: '000000' })).status).toBe(401);
  });

  it('when the practice requires it, nothing works until it is set up', async () => {
    const lead = await seedDoctor();
    const leadClient = await loginDoctor(lead);
    const staff = await join(leadClient, 'Pat Front Desk', 'staff', 'Smith Orthopedics');
    expect((await leadClient.post('/api/doctor/team/practice', { require_mfa: true })).status).toBe(409); // lead first
    await enableMfa(leadClient);
    expect((await leadClient.post('/api/doctor/team/practice', { require_mfa: true })).status).toBe(200);

    const me: any = await (await staff.client.fetch('/api/doctor/me')).json();
    expect(me.mfaSetupRequired).toBe(true);
    const blocked = await staff.client.fetch('/api/doctor/patients');
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'MFA_SETUP_REQUIRED' });
    await enableMfa(staff.client);
    expect((await staff.client.fetch('/api/doctor/patients')).status).toBe(200);
    expect((await staff.client.post('/api/doctor/mfa/disable', { password: staff.password })).status).toBe(409);
  });
});

describe('practices', () => {
  it('share invites; staff send them on a doctor’s behalf', async () => {
    const lead = await seedDoctor();
    const leadClient = await loginDoctor(lead);
    const { procedureId } = await seedProcedure(1, 30);
    const colleague = await join(leadClient, 'Dr. Jones', 'doctor', 'Smith Orthopedics');
    const staff = await join(leadClient, 'Pat Front Desk', 'staff');

    const me: any = await (await staff.client.fetch('/api/doctor/me')).json();
    expect(me).toMatchObject({ role: 'staff', practice: { name: 'Smith Orthopedics' } });
    expect(me.doctors.map((d: any) => d.name)).toHaveLength(2);
    expect(me.doctors.map((d: any) => d.name)).toContain('Dr. Jones');

    // Staff must say which doctor the invite is from.
    const invite = { patient_name: 'Ann Patient', patient_email: 'ann@mail.test', procedure_id: procedureId };
    expect((await staff.client.post('/api/doctor/prescribe', invite)).status).toBe(400);
    const jonesId = me.doctors.find((d: any) => d.name === 'Dr. Jones').id;
    const emails = captureEmails();
    let created: any;
    try {
      created = await (await staff.client.post('/api/doctor/prescribe', { ...invite, doctor_id: jonesId })).json();
      expect(emails.lastTo('ann@mail.test')!.subject).toContain('Dr. Jones');
    } finally {
      emails.restore();
    }
    const row = await env.DB.prepare(`SELECT doctor_id, created_by FROM prescriptions WHERE id = ?`).bind(created.prescriptionId).first<any>();
    expect(row.doctor_id).toBe(jonesId);

    // Everyone in the practice sees it, with who it's from and who sent it.
    for (const c of [leadClient, colleague.client, staff.client]) {
      const list: any = await (await c.fetch('/api/doctor/patients')).json();
      expect(list.find((x: any) => x.id === created.prescriptionId)).toMatchObject({ doctor_name: 'Dr. Jones', sent_by_name: 'Pat Front Desk' });
    }
    // A doctor outside the practice doesn't, and can't open it.
    const outsider = await loginDoctor(await seedDoctor());
    expect(((await (await outsider.fetch('/api/doctor/patients')).json()) as any[]).some((x) => x.id === created.prescriptionId)).toBe(false);
    expect((await outsider.fetch(`/api/doctor/prescriptions/${created.prescriptionId}`)).status).toBe(404);
    expect((await outsider.post('/api/doctor/prescribe', { ...invite, doctor_id: jonesId })).status).toBe(400);

    // A resend by the lead keeps Dr. Jones as the prescribing doctor.
    const resent: any = await (await leadClient.post(`/api/doctor/prescriptions/${created.prescriptionId}/resend`)).json();
    const again = await env.DB.prepare(`SELECT doctor_id, created_by FROM prescriptions WHERE id = ?`).bind(resent.prescriptionId).first<any>();
    expect(again.doctor_id).toBe(jonesId);
    expect(again.created_by).toBe(lead.id);
  });

  it('only doctors manage the team; turning off access ends sessions', async () => {
    const leadClient = await loginDoctor(await seedDoctor());
    const staff = await join(leadClient, 'Pat Front Desk', 'staff');
    expect((await staff.client.post('/api/doctor/team/invite', { name: 'X', email: 'x@clinic.test', role: 'staff' })).status).toBe(403);
    const team: any = await (await leadClient.fetch('/api/doctor/team')).json();
    expect(team.members).toHaveLength(2);
    const pat = team.members.find((m: any) => m.name === 'Pat Front Desk');
    expect((await staff.client.post(`/api/doctor/team/${pat.id}/disable`)).status).toBe(403);
    expect((await leadClient.post(`/api/doctor/team/${pat.id}/disable`)).status).toBe(200);
    expect((await staff.client.fetch('/api/doctor/me')).status).toBe(401);
    expect((await new Client().post('/api/doctor/login', { email: staff.email, password: staff.password })).status).toBe(401);
  });
});
