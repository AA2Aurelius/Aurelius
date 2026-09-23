// Packages a video for server-paced playback and uploads it.
//
//   npm run package-video -- --file hip-1.mp4 --procedure "Hip Replacement" \
//     --title "What to expect on the day" --order 1 [--remote] [--ffmpeg /path/to/ffmpeg]
//
// 1. ffmpeg re-encodes the video into HLS with fMP4 chunks of 4 seconds
//    (a keyframe forced every 4 s, so every chunk starts cleanly).
// 2. The init chunk and every media chunk are uploaded to R2 under
//    videos/<video id>/.
// 3. The procedure (created if no procedure has that name yet), the video
//    and its chunk list are inserted into D1.
// Targets the local dev database/bucket by default, or production with --remote.
// R2 uploads happen before the database insert, so the database never
// points at chunks that aren't there.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEGMENT_SECONDS = 4;
const BUCKET = 'aurelius-videos';
const DATABASE = 'aurelius-db';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (r.error) fail(`Could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} failed (exit ${r.status})${opts.quiet ? `:\n${r.stderr}` : ''}`);
  return r;
}

const sql = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const file = arg('file');
const procedureName = arg('procedure');
const title = arg('title');
const order = Number(arg('order'));
const ffmpeg = arg('ffmpeg') ?? process.env.FFMPEG ?? 'ffmpeg';
const target = process.argv.includes('--remote') ? '--remote' : '--local';
if (!file || !procedureName || !title || !Number.isInteger(order) || order < 1) {
  fail('Usage: npm run package-video -- --file video.mp4 --procedure "Hip Replacement" --title "Title" --order 1 [--remote] [--ffmpeg path]');
}
if (!existsSync(file)) fail(`No such file: ${file}`);

const work = mkdtempSync(join(tmpdir(), 'aurelius-package-'));
try {
  // ---- 1. encode ----
  console.log(`Encoding ${file} into ${SEGMENT_SECONDS}s chunks...`);
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(work, 'seg_%05d.m4s'), '-hls_flags', 'independent_segments',
    join(work, 'index.m3u8'),
  ]);

  // ---- parse the chunk list ffmpeg wrote ----
  const lines = readFileSync(join(work, 'index.m3u8'), 'utf8').split('\n').map((l) => l.trim());
  const segments = [];
  let startMs = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+),/.exec(lines[i]);
    if (!m) continue;
    const name = lines[i + 1];
    const durationMs = Math.round(Number(m[1]) * 1000);
    if (!name || durationMs <= 0) fail(`Unexpected playlist entry near line ${i + 1}`);
    segments.push({ idx: segments.length, name, startMs, durationMs });
    startMs += durationMs;
  }
  if (segments.length === 0) fail('ffmpeg produced no chunks.');
  const totalMs = startMs;

  // ---- 2. upload ----
  const videoId = randomUUID();
  const prefix = `videos/${videoId}`;
  const initKey = `${prefix}/init.mp4`;
  const put = (key, path, type) => run('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${path}`, `--content-type=${type}`, target], { quiet: true });
  console.log(`Uploading ${segments.length} chunks (${(totalMs / 1000).toFixed(1)}s) to R2 (${target.slice(2)})...`);
  put(initKey, join(work, 'init.mp4'), 'video/mp4');
  for (const s of segments) {
    s.key = `${prefix}/${s.name}`;
    put(s.key, join(work, s.name), 'video/iso.segment');
    process.stdout.write(`\r  ${s.idx + 1}/${segments.length}`);
  }
  process.stdout.write('\n');

  // ---- 3. database ----
  const now = new Date().toISOString();
  const procedureId = randomUUID();
  const procRef = `(SELECT id FROM procedures WHERE name = ${sql(procedureName)} ORDER BY created_at LIMIT 1)`;
  const statements = [
    `INSERT INTO procedures (id, name, created_at) SELECT ${sql(procedureId)}, ${sql(procedureName)}, ${sql(now)}
       WHERE NOT EXISTS (SELECT 1 FROM procedures WHERE name = ${sql(procedureName)});`,
    // r2_key predates chunked playback; it now points at the init chunk.
    `INSERT INTO videos (id, procedure_id, title, order_index, r2_key, duration_seconds, created_at, hls_init_r2_key)
       VALUES (${sql(videoId)}, ${procRef}, ${sql(title)}, ${order}, ${sql(initKey)}, ${Math.max(1, Math.round(totalMs / 1000))}, ${sql(now)}, ${sql(initKey)});`,
    ...segments.map((s) =>
      `INSERT INTO video_segments (video_id, idx, r2_key, start_ms, duration_ms) VALUES (${sql(videoId)}, ${s.idx}, ${sql(s.key)}, ${s.startMs}, ${s.durationMs});`),
  ];
  const sqlFile = join(work, 'insert.sql');
  writeFileSync(sqlFile, statements.join('\n') + '\n');
  console.log('Recording the video in D1...');
  run('npx', ['wrangler', 'd1', 'execute', DATABASE, target, `--file=${sqlFile}`], { quiet: true });

  console.log(`Done: video ${videoId}, "${title}" (#${order} in ${procedureName}), ${segments.length} chunks, ${(totalMs / 1000).toFixed(1)}s.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
