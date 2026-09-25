import { describe, expect, it } from 'vitest';
import { Client, INIT_BYTES, env, events, loginDoctor, prescribe, seedDoctor, seedEvergreen, segmentBytes, verifiedPatient } from './helpers';

// Evergreen order numbers are unique across the table, so each test uses its own.
let nextOrder = 100;
const order = () => nextOrder++;

async function bytes(res: Response) {
  return new Uint8Array(await res.arrayBuffer());
}

describe('evergreen videos: separate from procedure sets', () => {
  it('two evergreen videos cannot share an order', async () => {
    const n = order();
    await seedEvergreen('First', n);
    await expect(seedEvergreen('Second', n)).rejects.toThrow(/UNIQUE/);
  });

  it('are not counted in any procedure and are never prescribed', async () => {
    const eg = await seedEvergreen('Brain Science', order());
    const { doctorClient, procedureId, prescriptionId, token, patientEmail } = await prescribe({ videos: 2 });
    const procs = (await (await doctorClient.fetch('/api/doctor/procedures')).json()) as any[];
    expect(procs.find((p) => p.id === procedureId)).toMatchObject({ video_count: 2, total_seconds: 120 });
    const { results } = await env.DB.prepare(`SELECT video_id FROM video_progress WHERE prescription_id = ?`).bind(prescriptionId).all<any>();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.video_id)).not.toContain(eg);
    // Nor can an evergreen video be started as a paced playback.
    const patient = await verifiedPatient(token, patientEmail);
    expect((await patient.post(`/api/watch/${token}/video/${eg}/playback`)).status).toBe(404);
  });
});

describe('evergreen videos: doctor portal', () => {
  it('lists them in order and plays them as VOD', async () => {
    const a = order();
    const second = await seedEvergreen('How It Works', order(), 10);
    const first = await seedEvergreen('Brain Science', a, 10);
    const client = await loginDoctor(await seedDoctor());

    const list = (await (await client.fetch('/api/doctor/evergreen')).json()) as any;
    const mine = list.videos.filter((v: any) => v.id === first || v.id === second);
    expect(mine.map((v: any) => v.title)).toEqual(['Brain Science', 'How It Works']);
    expect(mine[0]).toMatchObject({ order: a, durationSeconds: 10, playlist: `evergreen/${first}/playlist.m3u8` });

    const pl = await client.fetch(`/api/doctor/evergreen/${first}/playlist.m3u8`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    const text = await pl.text();
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(text.match(/seg\/\d+\.m4s/g)).toEqual(['seg/0.m4s', 'seg/1.m4s', 'seg/2.m4s']);  // 4 s + 4 s + 2 s

    expect(await bytes(await client.fetch(`/api/doctor/evergreen/${first}/init.mp4`))).toEqual(INIT_BYTES);
    // Any chunk, in any order: evergreen videos aren't paced.
    expect(await bytes(await client.fetch(`/api/doctor/evergreen/${first}/seg/2.m4s`))).toEqual(segmentBytes(2));
    const ranged = await client.fetch(`/api/doctor/evergreen/${first}/seg/0.m4s`, { headers: { Range: 'bytes=0-9' } });
    expect(ranged.status).toBe(206);
    expect(await bytes(ranged)).toEqual(segmentBytes(0).slice(0, 10));
  });

  it('needs a signed-in doctor', async () => {
    const id = await seedEvergreen('Brain Science', order());
    const stranger = new Client();
    expect((await stranger.fetch('/api/doctor/evergreen')).status).toBe(401);
    expect((await stranger.fetch(`/api/doctor/evergreen/${id}/playlist.m3u8`)).status).toBe(401);
    expect((await stranger.fetch(`/api/doctor/evergreen/${id}/seg/0.m4s`)).status).toBe(401);
  });

  it('does not serve procedure videos through the evergreen routes', async () => {
    const { doctorClient, videoIds } = await prescribe({ videos: 1 });
    expect((await doctorClient.fetch(`/api/doctor/evergreen/${videoIds[0]}/playlist.m3u8`)).status).toBe(404);
    expect((await doctorClient.fetch(`/api/doctor/evergreen/${videoIds[0]}/init.mp4`)).status).toBe(404);
    expect((await doctorClient.fetch(`/api/doctor/evergreen/${videoIds[0]}/seg/0.m4s`)).status).toBe(404);
  });

  it('404s for a chunk that does not exist', async () => {
    const id = await seedEvergreen('Brain Science', order(), 8);
    const client = await loginDoctor(await seedDoctor());
    expect((await client.fetch(`/api/doctor/evergreen/${id}/seg/2.m4s`)).status).toBe(404);
    expect((await client.fetch(`/api/doctor/evergreen/${id}/seg/abc`)).status).toBe(404);
  });
});

describe('evergreen videos: patient portal', () => {
  it('a verified patient can list and play them, with nothing logged', async () => {
    const id = await seedEvergreen('Brain Science', order(), 10);
    const { token, patientEmail, prescriptionId } = await prescribe();
    const patient = await verifiedPatient(token, patientEmail);
    const before = (await events(prescriptionId)).length;

    const list = (await (await patient.fetch(`/api/watch/${token}/evergreen`)).json()) as any;
    expect(list.videos.find((v: any) => v.id === id)).toMatchObject({ title: 'Brain Science', playlist: `evergreen/${id}/playlist.m3u8` });
    const pl = await patient.fetch(`/api/watch/${token}/evergreen/${id}/playlist.m3u8`);
    expect(await pl.text()).toContain('#EXT-X-ENDLIST');
    expect(await bytes(await patient.fetch(`/api/watch/${token}/evergreen/${id}/init.mp4`))).toEqual(INIT_BYTES);
    expect(await bytes(await patient.fetch(`/api/watch/${token}/evergreen/${id}/seg/1.m4s`))).toEqual(segmentBytes(1));

    expect((await events(prescriptionId)).length).toBe(before);
  });

  it('needs a verified patient on a valid link', async () => {
    const id = await seedEvergreen('Brain Science', order());
    const { token } = await prescribe();
    const unverified = new Client();
    expect((await unverified.fetch(`/api/watch/${token}/evergreen`)).status).toBe(401);
    expect((await unverified.fetch(`/api/watch/${token}/evergreen/${id}/seg/0.m4s`)).status).toBe(401);
    expect((await unverified.fetch(`/api/watch/not-a-real-token/evergreen`)).status).toBe(410);
  });

  it('stops working once the doctor cancels the link', async () => {
    const id = await seedEvergreen('Brain Science', order());
    const { token, patientEmail, doctorClient, prescriptionId } = await prescribe();
    const patient = await verifiedPatient(token, patientEmail);
    expect((await patient.fetch(`/api/watch/${token}/evergreen/${id}/playlist.m3u8`)).status).toBe(200);
    expect((await doctorClient.post(`/api/doctor/prescriptions/${prescriptionId}/cancel`)).status).toBe(200);
    expect((await patient.fetch(`/api/watch/${token}/evergreen/${id}/playlist.m3u8`)).status).toBe(410);
  });
});

describe('procedure video previews for doctors', () => {
  it('lists a procedure\'s videos in order and plays them as VOD, with nothing logged', async () => {
    const { doctorClient, procedureId, videoIds, prescriptionId } = await prescribe({ videos: 2, duration: 10 });
    const before = (await events(prescriptionId)).length;

    const procs = (await (await doctorClient.fetch('/api/doctor/procedures')).json()) as any[];
    expect(procs.find((p) => p.id === procedureId)).toMatchObject({ first_video_id: videoIds[0], total_seconds: 20 });
    const patients = (await (await doctorClient.fetch('/api/doctor/patients')).json()) as any[];
    expect(patients.find((p) => p.id === prescriptionId).procedure_id).toBe(procedureId);

    const list = (await (await doctorClient.fetch(`/api/doctor/procedures/${procedureId}/videos`)).json()) as any;
    expect(list.procedure).toMatchObject({ id: procedureId, name: 'Hip Replacement' });
    expect(list.videos.map((v: any) => v.id)).toEqual(videoIds);
    expect(list.videos[0]).toMatchObject({ order: 1, durationSeconds: 10, playlist: `preview/${videoIds[0]}/playlist.m3u8` });

    const pl = await doctorClient.fetch(`/api/doctor/preview/${videoIds[0]}/playlist.m3u8`);
    expect(pl.status).toBe(200);
    const text = await pl.text();
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(text.match(/seg\/\d+\.m4s/g)).toEqual(['seg/0.m4s', 'seg/1.m4s', 'seg/2.m4s']);
    expect(await bytes(await doctorClient.fetch(`/api/doctor/preview/${videoIds[0]}/init.mp4`))).toEqual(INIT_BYTES);
    // Any chunk, in any order: a preview isn't paced.
    expect(await bytes(await doctorClient.fetch(`/api/doctor/preview/${videoIds[0]}/seg/2.m4s`))).toEqual(segmentBytes(2));

    expect((await events(prescriptionId)).length).toBe(before);
  });

  it('needs a signed-in doctor, and serves only procedure videos', async () => {
    const { procedureId, videoIds, doctorClient } = await prescribe({ videos: 1 });
    const stranger = new Client();
    expect((await stranger.fetch(`/api/doctor/procedures/${procedureId}/videos`)).status).toBe(401);
    expect((await stranger.fetch(`/api/doctor/preview/${videoIds[0]}/playlist.m3u8`)).status).toBe(401);
    expect((await stranger.fetch(`/api/doctor/preview/${videoIds[0]}/seg/0.m4s`)).status).toBe(401);

    const eg = await seedEvergreen('Brain Science', order());
    expect((await doctorClient.fetch(`/api/doctor/preview/${eg}/playlist.m3u8`)).status).toBe(404);
    expect((await doctorClient.fetch(`/api/doctor/procedures/not-a-procedure/videos`)).status).toBe(404);
  });
});

describe('poster frames', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  async function givePoster(table: 'videos' | 'evergreen_videos', id: string) {
    const key = `posters/${id}.jpg`;
    await env.VIDEOS.put(key, JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare(`UPDATE ${table} SET poster_r2_key = ? WHERE id = ?`).bind(key, id).run();
  }

  it('are listed only when present, and served to the patient for their own videos only', async () => {
    const { token, patientEmail, videoIds } = await prescribe({ videos: 2 });
    const patient = await verifiedPatient(token, patientEmail);
    let portal = (await (await patient.fetch(`/api/watch/${token}`)).json()) as any;
    expect(portal.videos.map((v: any) => v.poster)).toEqual([null, null]);
    expect(portal.videos[0]).not.toHaveProperty('poster_r2_key');
    expect((await patient.fetch(`/api/watch/${token}/video/${videoIds[0]}/poster.jpg`)).status).toBe(404);

    await givePoster('videos', videoIds[0]);
    portal = (await (await patient.fetch(`/api/watch/${token}`)).json()) as any;
    expect(portal.videos[0].poster).toBe(`video/${videoIds[0]}/poster.jpg`);
    const res = await patient.fetch(`/api/watch/${token}/${portal.videos[0].poster}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await bytes(res)).toEqual(JPEG);

    expect((await new Client().fetch(`/api/watch/${token}/video/${videoIds[0]}/poster.jpg`)).status).toBe(401);
    const other = await prescribe({ videos: 1 });
    await givePoster('videos', other.videoIds[0]);
    expect((await patient.fetch(`/api/watch/${token}/video/${other.videoIds[0]}/poster.jpg`)).status).toBe(404);
  });

  it('are served to doctors for previews and evergreen videos, and to patients for evergreen ones', async () => {
    const { doctorClient, procedureId, videoIds, token, patientEmail } = await prescribe({ videos: 1 });
    await givePoster('videos', videoIds[0]);
    const eg = await seedEvergreen('Brain Science', order());
    await givePoster('evergreen_videos', eg);

    const list = (await (await doctorClient.fetch(`/api/doctor/procedures/${procedureId}/videos`)).json()) as any;
    expect(list.videos[0].poster).toBe(`preview/${videoIds[0]}/poster.jpg`);
    expect(await bytes(await doctorClient.fetch(`/api/doctor/${list.videos[0].poster}`))).toEqual(JPEG);
    const procs = (await (await doctorClient.fetch('/api/doctor/procedures')).json()) as any[];
    expect(procs.find((p) => p.id === procedureId).first_video_has_poster).toBe(1);

    const egList = (await (await doctorClient.fetch('/api/doctor/evergreen')).json()) as any;
    const mine = egList.videos.find((v: any) => v.id === eg);
    expect(mine.poster).toBe(`evergreen/${eg}/poster.jpg`);
    expect(await bytes(await doctorClient.fetch(`/api/doctor/${mine.poster}`))).toEqual(JPEG);
    const patient = await verifiedPatient(token, patientEmail);
    expect(await bytes(await patient.fetch(`/api/watch/${token}/evergreen/${eg}/poster.jpg`))).toEqual(JPEG);
    expect((await new Client().fetch(`/api/doctor/${mine.poster}`)).status).toBe(401);
  });
});
