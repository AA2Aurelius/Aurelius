import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/stream';
import { VIDEO_BYTES, env, events, prescribe, verifiedPatient } from './helpers';

describe('parseRange', () => {
  it.each([
    [null, 1000, null],
    ['bytes=0-99', 1000, { offset: 0, length: 100 }],
    ['bytes=900-', 1000, { offset: 900, length: 100 }],
    ['bytes=990-5000', 1000, { offset: 990, length: 10 }],
    ['bytes=-100', 1000, { offset: 900, length: 100 }],
    ['bytes=-5000', 1000, { offset: 0, length: 1000 }],
    ['bytes=1000-', 1000, 'unsatisfiable'],
    ['bytes=-0', 1000, 'unsatisfiable'],
    ['bytes=0-', 0, 'unsatisfiable'],
    ['bytes=50-10', 1000, null],
    ['bytes=0-1,5-9', 1000, null],
    ['items=0-10', 1000, null],
    ['bytes=-', 1000, null],
  ])('%s of %d bytes', (header, size, expected) => {
    expect(parseRange(header as any, size)).toEqual(expected);
  });
});

describe('/stream', () => {
  it('serves 206 partial content with the right bytes and headers', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const res = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`, { headers: { Range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO_BYTES.slice(100, 200));
  });

  it('answers 416 when out of range, and serves the full file with 200 when there is no Range header', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const bad = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`, { headers: { Range: 'bytes=5000-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('Content-Range')).toBe('bytes */1000');
    await bad.arrayBuffer();
    // An unsatisfiable request doesn't count as the video starting.
    const row = await env.DB.prepare(`SELECT started_at FROM video_progress WHERE prescription_id = ? AND video_id = ?`).bind(s.prescriptionId, s.videoIds[0]).first<any>();
    expect(row.started_at).toBeNull();

    const full = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('1000');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(VIDEO_BYTES);
  });

  it('answers HEAD without a body and without starting the clock', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    const res = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('1000');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const row = await env.DB.prepare(`SELECT started_at FROM video_progress WHERE prescription_id = ? AND video_id = ?`).bind(s.prescriptionId, s.videoIds[0]).first<any>();
    expect(row.started_at).toBeNull();
  });

  it('starts the clock once, however many range requests follow', async () => {
    const s = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    for (const range of ['bytes=0-1', 'bytes=0-', 'bytes=500-999', 'bytes=-10']) {
      const r = await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[0]}/stream`, { headers: { Range: range } });
      await r.arrayBuffer();
    }
    const row = await env.DB.prepare(`SELECT started_at FROM video_progress WHERE prescription_id = ? AND video_id = ?`).bind(s.prescriptionId, s.videoIds[0]).first<any>();
    expect(row.started_at).not.toBeNull();
    expect((await events(s.prescriptionId)).filter((e) => e.event_type === 'stream_start')).toHaveLength(1);
  });

  it("refuses a locked video and a video that isn't in this prescription", async () => {
    const s = await prescribe();
    const other = await prescribe();
    const p = await verifiedPatient(s.token, s.patientEmail);
    expect((await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[1]}/stream`)).status).toBe(403);
    expect((await p.fetch(`/api/watch/${s.token}/video/${other.videoIds[0]}/stream`)).status).toBe(404);
  });
});
