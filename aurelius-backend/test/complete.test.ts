import { describe, expect, it } from 'vitest';
import { backdateStart, env, events, prescribe, verifiedPatient, watchAndComplete } from './helpers';

async function progress(prescriptionId: string, videoId: string) {
  return env.DB.prepare(`SELECT * FROM video_progress WHERE prescription_id = ? AND video_id = ?`).bind(prescriptionId, videoId).first<any>();
}

describe('/complete', () => {
  it('refuses a video that was never streamed', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    expect((await p.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/complete`)).status).toBe(409);
    expect((await progress(s.prescriptionId, s.videoIds[0])).completed_at).toBeNull();
  });

  it('refuses completion before the video could have been watched, and logs the attempt', async () => {
    const s = await prescribe({ duration: 60 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    await (await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).arrayBuffer();
    await backdateStart(s.prescriptionId, s.videoIds[0], 30); // only half the video's length

    const res = await p.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/complete`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).secondsRemaining).toBeGreaterThan(25);
    expect((await progress(s.prescriptionId, s.videoIds[0])).completed_at).toBeNull();
    const rejected = (await events(s.prescriptionId)).filter((e) => e.event_type === 'complete_rejected');
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0].meta).reason).toBe('too_early');
  });

  it('completes once enough time has passed since the first stream', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const res = await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    expect(res.status).toBe(200);
    expect((await progress(s.prescriptionId, s.videoIds[0])).completed_at).not.toBeNull();
    const complete = (await events(s.prescriptionId)).filter((e) => e.event_type === 'complete');
    expect(complete).toHaveLength(1);
    expect(JSON.parse(complete[0].meta).verification_level).toBe('interim-time-check');
  });

  it('refuses to complete a locked video, even if it was somehow started', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    await backdateStart(s.prescriptionId, s.videoIds[1], 600);
    expect((await p.post(`/api/watch/${s.token}/video/${s.videoIds[1]}/complete`)).status).toBe(403);
    expect((await progress(s.prescriptionId, s.videoIds[1])).completed_at).toBeNull();
  });

  it("refuses a video that isn't in this prescription and writes no event for it", async () => {
    const s = await prescribe();
    const other = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const before = (await events(s.prescriptionId)).length;
    expect((await p.post(`/api/watch/${s.token}/video/${other.videoIds[0]}/complete`)).status).toBe(404);
    expect((await p.post(`/api/watch/${s.token}/video/not-a-video/complete`)).status).toBe(404);
    expect((await events(s.prescriptionId)).length).toBe(before);
  });

  it('is idempotent: completing twice writes one completion', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    const first = (await progress(s.prescriptionId, s.videoIds[0])).completed_at;
    const again = await p.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/complete`);
    expect(((await again.json()) as any).alreadyComplete).toBe(true);
    expect((await progress(s.prescriptionId, s.videoIds[0])).completed_at).toBe(first);
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'complete')).toHaveLength(1);
  });

  it('handles concurrent completion requests without double-logging', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    await (await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`)).arrayBuffer();
    await backdateStart(s.prescriptionId, s.videoIds[0], 60);
    const results = await Promise.all([1, 2, 3].map(() => p.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/complete`)));
    for (const r of results) expect(r.status).toBe(200);
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'complete')).toHaveLength(1);
  });

  it('unlocks the next video only after the previous one is complete', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    expect((await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[1]}/stream`)).status).toBe(403);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    const next = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[1]}/stream`);
    expect(next.status).toBe(200);
    await next.arrayBuffer();
  });
});

describe('client-reported events', () => {
  it('counts pauses and seek attempts, and logs them as client-reported', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const v = s.videoIds[0];
    await p.post(`/api/watch/${s.token}/video/${v}/event`, { type: 'play', position: 0 });
    await p.post(`/api/watch/${s.token}/video/${v}/event`, { type: 'pause', position: 12.5 });
    await p.post(`/api/watch/${s.token}/video/${v}/event`, { type: 'pause', position: 20 });
    await p.post(`/api/watch/${s.token}/video/${v}/seek-attempt`, { from: 20, to: 55 });
    expect((await p.post(`/api/watch/${s.token}/video/${v}/event`, { type: 'complete' })).status).toBe(400);

    const row = await progress(s.prescriptionId, v);
    expect(row.pause_count).toBe(2);
    expect(row.seek_attempts).toBe(1);
    expect(row.completed_at).toBeNull();
    const seek = (await events(s.prescriptionId)).find((e) => e.event_type === 'seek_attempt');
    expect(JSON.parse(seek.meta)).toMatchObject({ source: 'client', from: 20, to: 55 });
  });

  it('rate-limits event floods', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      limited = (await p.post(`/api/watch/${s.token}/video/${s.videoIds[0]}/event`, { type: 'play' })).status === 429;
    }
    expect(limited).toBe(true);
  });
});
