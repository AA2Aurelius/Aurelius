// Packages videos for playback and uploads them.
//
// One video:
//   npm run package-video -- --file hip-1.mp4 --procedure "Hip Replacement" \
//     --title "What to expect on the day" --order 1 [--remote]
//   npm run package-video -- --file brain.mp4 --evergreen --title "Brain Science" --order 1 [--remote]
//
// A batch, from a CSV with the columns file,procedure,title,order (leave
// procedure blank for an evergreen video; file paths are relative to the CSV):
//   npm run package-video -- --manifest videos.csv [--remote]
//
// Other options: --ffmpeg /path/to/ffmpeg, --concurrency N (parallel chunk
// uploads, default 6), --poster-at SECONDS (where the still frame is taken;
// default 30% of the way in).
//
// Still frames for videos already uploaded (same manifest; nothing is
// re-encoded, only a frame is taken and uploaded for each):
//   npm run package-video -- --manifest videos.csv --posters [--remote]
//
// For each video:
// 1. ffmpeg re-encodes it into HLS with fMP4 chunks of 4 seconds (a keyframe
//    forced every 4 s, so every chunk starts cleanly).
// 2. The init chunk and every media chunk are uploaded to R2 under
//    videos/<video id>/.
// 3. A still frame is saved to R2 as posters/<video id>.jpg, for its card.
// 4. The procedure (created if no procedure has that name yet), the video
//    and its chunk list are inserted into D1.
// Targets the local dev database/bucket by default, or production with --remote.
// R2 uploads happen before the database insert, so the database never
// points at chunks that aren't there.
//
// Re-running is safe: a video already in the database (same procedure and
// order, same title) is skipped, so a batch that stopped partway picks up
// where it left off. A different title at a taken position stops the batch
// before anything is encoded.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEGMENT_SECONDS = 4;
const BUCKET = 'aurelius-videos';
const DATABASE = 'aurelius-db';

class Failure extends Error {}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(msg) {
  throw new Failure(msg);
}

// wrangler from this package's node_modules (much faster than npx per chunk).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localWrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const wrangler = existsSync(localWrangler) ? [localWrangler] : ['npx', 'wrangler'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`Could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} failed (exit ${r.status})${opts.quiet ? `:\n${r.stderr || r.stdout}` : ''}`);
  return r;
}

function runAsync(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => reject(new Failure(`Could not run ${cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Failure(`${cmd} failed (exit ${code}):\n${out}`))));
  });
}

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

const sql = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ------------------------------------------------------------------ CSV

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
// Tolerates the byte-order mark Excel writes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) fail('The CSV has an unclosed quote.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function readManifest(path) {
  if (!existsSync(path)) fail(`No such manifest: ${path}`);
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (rows.length < 2) fail('The manifest needs a header row (file,procedure,title,order) and at least one video.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const name of ['file', 'procedure', 'title', 'order']) {
    col[name] = header.indexOf(name);
    if (col[name] === -1) fail(`The manifest's header row is missing the "${name}" column (found: ${rows[0].join(', ')}).`);
  }
  const base = dirname(resolve(path));
  return rows.slice(1).map((r, i) => {
    const file = expandHome((r[col.file] ?? '').trim());
    const procedure = (r[col.procedure] ?? '').trim();
    return {
      line: i + 2,
      file: file && !isAbsolute(file) ? join(base, file) : file,
      procedure: procedure || null,
      title: (r[col.title] ?? '').trim(),
      order: Number((r[col.order] ?? '').trim()),
    };
  });
}

// ------------------------------------------------------------- validate

const label = (v) => `${v.procedure ?? 'Evergreen'} #${v.order} "${v.title}"`;
const slot = (procedure, order) => `${procedure ?? '\u0000evergreen'}\u0000${order}`;

function validate(videos) {
  const problems = [];
  const seen = new Map();
  for (const v of videos) {
    const where = v.line ? `Line ${v.line}` : 'Video';
    if (!v.file) problems.push(`${where}: no file given.`);
    else if (!existsSync(v.file) || !statSync(v.file).isFile()) problems.push(`${where}: no such file: ${v.file}`);
    if (!v.title) problems.push(`${where}: no title given.`);
    if (!Number.isInteger(v.order) || v.order < 1) problems.push(`${where}: order must be a whole number from 1 up.`);
    const key = slot(v.procedure, v.order);
    if (seen.has(key)) problems.push(`${where}: ${v.procedure ?? 'Evergreen'} #${v.order} is also used on ${seen.get(key)}.`);
    else seen.set(key, v.line ? `line ${v.line}` : 'another video');
  }
  if (problems.length) fail(`Nothing was uploaded. Please fix the following and run it again:\n  ${problems.join('\n  ')}`);
}

function d1Query(target, command) {
  const r = run(wrangler[0], [...wrangler.slice(1), 'd1', 'execute', DATABASE, target, '--json', `--command=${command}`], { quiet: true });
  const start = r.stdout.indexOf('[');
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.slice(start));
  } catch {
    fail(`Unexpected output from wrangler d1 execute:\n${r.stdout}`);
  }
  return parsed.flatMap((p) => p.results ?? []);
}

// ---------------------------------------------------------- still frame

// Where to take the still frame: --poster-at, or 30% of the way in (past any
// opening titles), read with ffprobe; 3 s if the length can't be read.
function posterSeconds(ffmpeg, file) {
  const at = arg('poster-at');
  if (at !== undefined) {
    const n = Number(at);
    if (!Number.isFinite(n) || n < 0) fail('--poster-at must be a number of seconds.');
    return n;
  }
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const d = Number((r.stdout ?? '').trim());
  return Number.isFinite(d) && d > 0 ? Math.max(0, Math.min(d * 0.3, d - 0.5)) : 3;
}

function makePoster(ffmpeg, file, out) {
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', posterSeconds(ffmpeg, file).toFixed(2), '-i', file,
    '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', out,
  ]);
  if (!existsSync(out)) fail(`ffmpeg made no still frame for ${file}`);
}

const putObject = (key, path, type, target) =>
  runAsync(wrangler[0], [...wrangler.slice(1), 'r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${path}`, `--content-type=${type}`, target]);

// ------------------------------------------------------------ one video

async function packageOne(v, { target, ffmpeg, concurrency }) {
  const work = mkdtempSync(join(tmpdir(), 'aurelius-package-'));
  try {
    // ---- 1. encode ----
    console.log(`  Encoding into ${SEGMENT_SECONDS}s chunks...`);
    run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', v.file,
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
    const put = (key, path, type) => putObject(key, path, type, target);
    console.log(`  Uploading ${segments.length} chunks (${(totalMs / 1000).toFixed(1)}s) to R2 (${target.slice(2)})...`);
    await put(initKey, join(work, 'init.mp4'), 'video/mp4');
    let done = 0;
    await pool(segments, concurrency, async (s) => {
      s.key = `${prefix}/${s.name}`;
      await put(s.key, join(work, s.name), 'video/iso.segment');
      process.stdout.write(`\r    ${++done}/${segments.length}`);
    });
    process.stdout.write('\n');

    // ---- 3. still frame ----
    const posterKey = `posters/${videoId}.jpg`;
    makePoster(ffmpeg, v.file, join(work, 'poster.jpg'));
    await put(posterKey, join(work, 'poster.jpg'), 'image/jpeg');

    // ---- 4. database ----
    const now = new Date().toISOString();
    const statements = [];
    const seconds = Math.max(1, Math.round(totalMs / 1000));
    if (v.procedure) {
      const procRef = `(SELECT id FROM procedures WHERE name = ${sql(v.procedure)} ORDER BY created_at LIMIT 1)`;
      statements.push(
        `INSERT INTO procedures (id, name, created_at) SELECT ${sql(randomUUID())}, ${sql(v.procedure)}, ${sql(now)}
           WHERE NOT EXISTS (SELECT 1 FROM procedures WHERE name = ${sql(v.procedure)});`,
        // r2_key predates chunked playback; it now points at the init chunk.
        `INSERT INTO videos (id, procedure_id, title, order_index, r2_key, duration_seconds, created_at, hls_init_r2_key, poster_r2_key)
           VALUES (${sql(videoId)}, ${procRef}, ${sql(v.title)}, ${v.order}, ${sql(initKey)}, ${seconds}, ${sql(now)}, ${sql(initKey)}, ${sql(posterKey)});`,
      );
    } else {
      statements.push(
        `INSERT INTO evergreen_videos (id, title, order_index, duration_seconds, hls_init_r2_key, created_at, poster_r2_key)
           VALUES (${sql(videoId)}, ${sql(v.title)}, ${v.order}, ${seconds}, ${sql(initKey)}, ${sql(now)}, ${sql(posterKey)});`,
      );
    }
    const segmentTable = v.procedure ? 'video_segments' : 'evergreen_segments';
    statements.push(...segments.map((s) =>
      `INSERT INTO ${segmentTable} (video_id, idx, r2_key, start_ms, duration_ms) VALUES (${sql(videoId)}, ${s.idx}, ${sql(s.key)}, ${s.startMs}, ${s.durationMs});`));
    const sqlFile = join(work, 'insert.sql');
    writeFileSync(sqlFile, statements.join('\n') + '\n');
    console.log('  Recording the video in D1...');
    run(wrangler[0], [...wrangler.slice(1), 'd1', 'execute', DATABASE, target, `--file=${sqlFile}`, ...(target === '--remote' ? ['--yes'] : [])], { quiet: true });

    return { videoId, chunks: segments.length, seconds: totalMs / 1000 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --------------------------------------------- frames for existing videos

// --posters: take a still frame from each listed video that's already
// uploaded (matched by procedure, order and title), upload it and record it.
// Nothing is re-encoded; re-running replaces the frames.
async function postersOnly(videos, { target, ffmpeg }) {
  console.log(`Matching the videos to what's in D1 (${target.slice(2)})...`);
  const rows = d1Query(target,
    'SELECT v.id, p.name AS procedure, v.order_index, v.title FROM videos v JOIN procedures p ON p.id = v.procedure_id; '
    + 'SELECT id, NULL AS procedure, order_index, title FROM evergreen_videos');
  const byslot = new Map(rows.map((r) => [slot(r.procedure, r.order_index), r]));
  const work = mkdtempSync(join(tmpdir(), 'aurelius-posters-'));
  const updates = [];
  const skipped = [];
  try {
    for (const [i, v] of videos.entries()) {
      const row = byslot.get(slot(v.procedure, v.order));
      if (!row || row.title !== v.title) {
        skipped.push(`${label(v)}: ${row ? `that position is "${row.title}"` : 'not uploaded yet'}`);
        continue;
      }
      console.log(`[${i + 1}/${videos.length}] ${label(v)}`);
      const out = join(work, `${row.id}.jpg`);
      makePoster(ffmpeg, v.file, out);
      const key = `posters/${row.id}.jpg`;
      await putObject(key, out, 'image/jpeg', target);
      updates.push(`UPDATE ${v.procedure ? 'videos' : 'evergreen_videos'} SET poster_r2_key = ${sql(key)} WHERE id = ${sql(row.id)};`);
    }
    if (updates.length) {
      const sqlFile = join(work, 'posters.sql');
      writeFileSync(sqlFile, updates.join('\n') + '\n');
      console.log('Recording the frames in D1...');
      run(wrangler[0], [...wrangler.slice(1), 'd1', 'execute', DATABASE, target, `--file=${sqlFile}`, ...(target === '--remote' ? ['--yes'] : [])], { quiet: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\nStill frames added for ${updates.length} video${updates.length === 1 ? '' : 's'}.`);
  if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`);
}

// ------------------------------------------------------------------ main

async function main() {
  const target = process.argv.includes('--remote') ? '--remote' : '--local';
  const ffmpeg = arg('ffmpeg') ?? process.env.FFMPEG ?? 'ffmpeg';
  const concurrency = Number(arg('concurrency') ?? 6);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fail('--concurrency must be a whole number from 1 to 32.');

  let videos;
  const manifest = arg('manifest');
  if (manifest) {
    videos = readManifest(manifest);
  } else {
    const evergreen = process.argv.includes('--evergreen');
    const procedure = arg('procedure');
    if (!arg('file') || !arg('title') || !arg('order') || evergreen === !!procedure) {
      fail('Usage:\n'
        + '  npm run package-video -- --file video.mp4 --procedure "Hip Replacement" --title "Title" --order 1 [--remote]\n'
        + '  npm run package-video -- --file video.mp4 --evergreen --title "Brain Science" --order 1 [--remote]\n'
        + '  npm run package-video -- --manifest videos.csv [--remote]\n'
        + 'Options: --ffmpeg path, --concurrency N');
    }
    videos = [{ file: expandHome(arg('file')), procedure: evergreen ? null : procedure, title: arg('title'), order: Number(arg('order')) }];
  }
  validate(videos);

  const probe = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) fail(`ffmpeg not found (tried "${ffmpeg}"). Install it (on a Mac: brew install ffmpeg) or pass --ffmpeg /path/to/ffmpeg.`);

  if (process.argv.includes('--posters')) return postersOnly(videos, { target, ffmpeg });

  // What's already there, so a re-run skips finished videos.
  console.log(`Checking what's already in D1 (${target.slice(2)})...`);
  const existing = new Map();
  const rows = d1Query(target,
    'SELECT p.name AS procedure, v.order_index, v.title FROM videos v JOIN procedures p ON p.id = v.procedure_id; '
    + 'SELECT NULL AS procedure, order_index, title FROM evergreen_videos');
  for (const r of rows) existing.set(slot(r.procedure, r.order_index), r.title);
  const conflicts = videos
    .filter((v) => existing.has(slot(v.procedure, v.order)) && existing.get(slot(v.procedure, v.order)) !== v.title)
    .map((v) => `${v.line ? `Line ${v.line}: ` : ''}${v.procedure ?? 'Evergreen'} #${v.order} is already "${existing.get(slot(v.procedure, v.order))}", not "${v.title}".`);
  if (conflicts.length) fail(`Nothing was uploaded. These positions are already taken by a different video:\n  ${conflicts.join('\n  ')}`);

  const results = [];
  for (const [i, v] of videos.entries()) {
    const head = videos.length > 1 ? `[${i + 1}/${videos.length}] ` : '';
    if (existing.has(slot(v.procedure, v.order))) {
      console.log(`${head}${label(v)}: already uploaded, skipped.`);
      results.push({ v, status: 'skipped' });
      continue;
    }
    console.log(`${head}${label(v)} (${v.file})`);
    try {
      const r = await packageOne(v, { target, ffmpeg, concurrency });
      console.log(`  Done: video ${r.videoId}, ${r.chunks} chunks, ${r.seconds.toFixed(1)}s.`);
      results.push({ v, status: 'uploaded', ...r });
    } catch (e) {
      const done = results.filter((r) => r.status === 'uploaded').length;
      fail(`${e.message}\n\nStopped at ${label(v)}. ${done} video(s) were uploaded before this; run the same command again to continue (finished videos are skipped).`);
    }
  }

  if (videos.length > 1) {
    console.log('\nSummary:');
    for (const r of results) {
      console.log(`  ${r.status === 'uploaded' ? 'uploaded' : 'skipped '}  ${label(r.v)}${r.videoId ? `  ${r.videoId}  ${r.chunks} chunks, ${r.seconds.toFixed(1)}s` : ''}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Failure ? e.message : e);
  process.exit(1);
});
