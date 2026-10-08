import { describe, expect, it } from 'vitest';
import { Client, env, prescribe, seedEvergreen, verifiedPatient } from './helpers';

const VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nWelcome.\n';

describe('captions', () => {
  it('are served only to the verified patient, and listed in the portal', async () => {
    const s = await prescribe({ videos: 2, duration: 30 });
    await env.DB.prepare(`UPDATE videos SET captions_vtt = ? WHERE id = ?`).bind(VTT, s.videoIds[0]).run();
    const url = `/api/watch/${s.token}/video/${s.videoIds[0]}/captions.vtt`;

    expect((await new Client().fetch(url)).status).toBe(401);
    const p = await verifiedPatient(s.token, s.patientEmail);
    const res = await p.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/vtt');
    expect(await res.text()).toBe(VTT);
    // A video without captions, and a video from someone else's set.
    expect((await p.fetch(`/api/watch/${s.token}/video/${s.videoIds[1]}/captions.vtt`)).status).toBe(404);
    const other = await prescribe({ videos: 1 });
    await env.DB.prepare(`UPDATE videos SET captions_vtt = ? WHERE id = ?`).bind(VTT, other.videoIds[0]).run();
    expect((await p.fetch(`/api/watch/${s.token}/video/${other.videoIds[0]}/captions.vtt`)).status).toBe(404);

    const portal: any = await (await p.fetch(`/api/watch/${s.token}`)).json();
    expect(portal.videos[0].captions).toBe(`video/${s.videoIds[0]}/captions.vtt`);
    expect(portal.videos[1].captions).toBeNull();

    // Doctors' previews carry them too.
    const list: any = await (await s.doctorClient.fetch(`/api/doctor/procedures/${s.procedureId}/videos`)).json();
    expect(list.videos[0].captions).toBe(`preview/${s.videoIds[0]}/captions.vtt`);
    expect(await (await s.doctorClient.fetch(`/api/doctor/${list.videos[0].captions}`)).text()).toBe(VTT);
  });

  it('for the evergreen videos are public, like the videos', async () => {
    const id = await seedEvergreen('Brain Science', 1);
    await env.DB.prepare(`UPDATE evergreen_videos SET captions_vtt = ? WHERE id = ?`).bind(VTT, id).run();
    const list: any = await (await new Client().fetch('/api/public/evergreen')).json();
    const v = list.videos.find((x: any) => x.id === id);
    expect(v.captions).toBe(`evergreen/${id}/captions.vtt`);
    expect(await (await new Client().fetch(`/api/public/${v.captions}`)).text()).toBe(VTT);
  });
});
