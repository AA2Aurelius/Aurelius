import { describe, expect, it } from 'vitest';
import { playVideo, prescribe, verifiedPatient, watchAndComplete } from './helpers';

describe('where a patient left off', () => {
  it('shows the patient how far into an unfinished video they got, and nothing for finished ones', async () => {
    const s = await prescribe({ videos: 2, duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    await playVideo(p, s.token, s.videoIds[1], { stopAtMs: 20000 });

    const portal = (await (await p.fetch(`/api/watch/${s.token}`)).json()) as any;
    const [first, second] = portal.videos;
    expect(first).toMatchObject({ complete: true, resume_seconds: 0 });
    expect(second.complete).toBe(false);
    expect(second.resume_seconds).toBeGreaterThanOrEqual(15);
    expect(second.resume_seconds).toBeLessThan(60);
    expect(second).not.toHaveProperty('resume_ms');
  });
});

describe("the doctor's view of a patient's viewing", () => {
  it('shows how much of each video was watched, checks passed, when they confirmed and their last activity', async () => {
    const s = await prescribe({ videos: 2, duration: 60 });
    const before = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}`)).json()) as any;
    expect(before).toMatchObject({ confirmed_at: null, last_activity_at: null });
    expect(before.videos.map((v: any) => v.watched_ms)).toEqual([0, 0]);

    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    await playVideo(p, s.token, s.videoIds[1], { stopAtMs: 20000 });

    const d = (await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}`)).json()) as any;
    expect(d.confirmed_at).toMatch(/Z$/);
    expect(d.last_activity_at).toMatch(/Z$/);
    const [first, second] = d.videos;
    expect(first.watched_ms).toBe(60000);
    expect(first.checks_passed).toBeGreaterThanOrEqual(1);
    expect(second.completed_at).toBeNull();
    expect(second.watched_ms).toBeGreaterThan(0);
    expect(second.watched_ms).toBeLessThan(60000);
  });
});
