import { describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/index';
import { captureEmails, env, events, prescribe, verifiedPatient, watchAndComplete } from './helpers';

async function setExpiry(prescriptionId: string, hoursFromNow: number) {
  await env.DB.prepare(`UPDATE prescriptions SET expires_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() + hoursFromNow * 3600_000).toISOString(), prescriptionId).run();
}

describe('12h reminder sweep', () => {
  it('reminds patient and doctor only for live, unfinished links inside the window, exactly once', async () => {
    const due = await prescribe();
    await setExpiry(due.prescriptionId, 11);

    const tooEarly = await prescribe();            // 30h left
    await setExpiry(tooEarly.prescriptionId, 30);

    const expired = await prescribe();
    await setExpiry(expired.prescriptionId, -1);

    const revoked = await prescribe();
    await setExpiry(revoked.prescriptionId, 11);
    await env.DB.prepare(`UPDATE prescriptions SET revoked_at = ? WHERE id = ?`).bind(new Date().toISOString(), revoked.prescriptionId).run();

    const finished = await prescribe({ videos: 1 });
    const p = await verifiedPatient(finished.token, finished.patientEmail);
    await watchAndComplete(p, finished.token, finished.prescriptionId, finished.videoIds[0]);
    await setExpiry(finished.prescriptionId, 11);

    const emails = captureEmails();
    try {
      await runReminderSweep(env);
      await runReminderSweep(env); // a second run must not resend

      const recipients = emails.sent.map((e) => e.to).sort();
      expect(recipients).toEqual([due.doctor.email, due.patientEmail].sort());
      expect(emails.lastTo(due.patientEmail)!.text).toContain('0 of 2');

      const reminded = (await events(due.prescriptionId)).filter((e) => e.event_type === 'reminder_12h');
      expect(reminded).toHaveLength(1);
      expect(JSON.parse(reminded[0].meta)).toEqual({ doctor: 'sent', patient: 'sent' });
      for (const other of [tooEarly, expired, revoked, finished]) {
        expect((await events(other.prescriptionId)).some((e) => e.event_type === 'reminder_12h')).toBe(false);
      }
    } finally {
      emails.restore();
    }
  });

  it('uses the partial expiry index rather than scanning every prescription', async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM prescriptions
       WHERE reminder_12h_sent_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND expires_at <= ?`
    ).bind('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').all<any>();
    expect(JSON.stringify(plan.results)).toContain('idx_prescriptions_expiry');
  });
});
