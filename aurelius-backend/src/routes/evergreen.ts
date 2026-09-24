import type { Hono, MiddlewareHandler } from 'hono';
import { Env } from '../lib';
import { Segment, hlsPlaylist } from '../playback';
import { serveR2Object } from '../stream';
import { AppEnv } from './common';

// The evergreen explainer videos ("Brain Science", "How It Works"), shown at
// the top of both portals. They aren't part of any prescription, so they
// play as ordinary VOD: no pacing, no heartbeats, nothing on the audit
// chain or the certificate. Only signed-in doctors and verified patients
// can fetch them.

interface EvergreenVideo {
  id: string;
  title: string;
  order_index: number;
  duration_seconds: number;
  hls_init_r2_key: string;
}

async function evergreenVideo(env: Env, id: string): Promise<EvergreenVideo | null> {
  return env.DB.prepare(`SELECT * FROM evergreen_videos WHERE id = ?`)
    .bind(id).first<EvergreenVideo>();
}

const noGuard: MiddlewareHandler<AppEnv> = (_c, next) => next();

// Registers GET {base}, {base}/:videoId/playlist.m3u8, .../init.mp4 and
// .../seg/:n.m4s on `app`, each behind `guard`.
export function registerEvergreenRoutes(app: Hono<AppEnv>, base: string, guard: MiddlewareHandler<AppEnv> = noGuard) {
  app.get(base, guard, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, title, order_index, duration_seconds FROM evergreen_videos ORDER BY order_index`
    ).all<EvergreenVideo>();
    return c.json({
      videos: results.map((v) => ({
        id: v.id,
        title: v.title,
        order: v.order_index,
        durationSeconds: v.duration_seconds,
        playlist: `evergreen/${v.id}/playlist.m3u8`,
      })),
    });
  });

  app.get(`${base}/:videoId/playlist.m3u8`, guard, async (c) => {
    const video = await evergreenVideo(c.env, c.req.param('videoId') ?? '');
    if (!video) return c.json({ error: 'Not found.' }, 404);
    const { results: segments } = await c.env.DB.prepare(`SELECT idx, start_ms, duration_ms FROM evergreen_segments WHERE video_id = ? ORDER BY idx`)
      .bind(video.id).all<Segment>();
    if (segments.length === 0) return c.json({ error: 'Not found.' }, 404);
    const body = hlsPlaylist(segments, segments.length - 1, true, true);
    return new Response(body, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-store' } });
  });

  app.get(`${base}/:videoId/init.mp4`, guard, async (c) => {
    const video = await evergreenVideo(c.env, c.req.param('videoId') ?? '');
    const res = video && (await serveR2Object(c.env.VIDEOS, video.hls_init_r2_key, c.req.raw));
    return res || c.json({ error: 'Not found.' }, 404);
  });

  app.get(`${base}/:videoId/seg/:file`, guard, async (c) => {
    const m = /^(\d{1,6})\.m4s$/.exec(c.req.param('file'));
    if (!m) return c.json({ error: 'Not found.' }, 404);
    const seg = await c.env.DB.prepare(
      `SELECT r2_key FROM evergreen_segments WHERE video_id = ? AND idx = ?`
    ).bind(c.req.param('videoId') ?? '', Number(m[1])).first<{ r2_key: string }>();
    const res = seg && (await serveR2Object(c.env.VIDEOS, seg.r2_key, c.req.raw));
    return res || c.json({ error: 'Not found.' }, 404);
  });
}
