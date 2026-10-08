// Adds captions to videos. Takes the caption files your editing or
// transcription software exports: WebVTT (.vtt) or SubRip (.srt).
//
//   npm run captions -- --procedure "Hip Replacement" --video 1 --file hip-1.vtt [--remote]
//   npm run captions -- --evergreen "Brain Science" --file brain.srt [--remote]
//   npm run captions -- --manifest captions.csv [--remote]
//   npm run captions -- --list [--remote]
//   npm run captions -- --procedure "Hip Replacement" --video 1 --remove [--remote]
//
// The manifest is a CSV with columns: procedure, video, file. For an
// evergreen video, leave video empty and put its title in procedure, e.g.
// `Brain Science,,brain.vtt`. File paths are relative to the CSV.
// Adding captions again replaces the old ones.
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCsv } from './csv.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const target = process.argv.includes('--remote') ? '--remote' : '--local';
const where = target === '--remote' ? 'live' : 'local';
const sqlString = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function query(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, '--json', `--command=${sql}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0 || r.error) fail(`The database query failed:\n${r.error ? r.error.message : r.stdout}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).flatMap((x) => x.results ?? []);
}
function runFile(sql) {
  const file = '.captions.sql';
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, `--file=${file}`], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } finally {
    unlinkSync(file);
  }
}

// Turns an .srt or .vtt file into clean WebVTT, or explains what's wrong.
export function toVtt(text, name) {
  let t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  const isVtt = t.startsWith('WEBVTT');
  if (!isVtt) {
    // SubRip: "00:00:01,000 --> 00:00:03,500" becomes "00:00:01.000 --> 00:00:03.500".
    t = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    t = `WEBVTT\n\n${t}`;
  }
  const cues = (t.match(/\d{1,2}:\d{2}(:\d{2})?\.\d{3}\s+-->\s+\d{1,2}:\d{2}(:\d{2})?\.\d{3}/g) ?? []).length;
  if (cues === 0) fail(`${name} doesn't look like a caption file: no timings like "00:00:01.000 --> 00:00:03.500" found.`);
  if (t.length > 500_000) fail(`${name} is too large for a caption file.`);
  return { vtt: `${t}\n`, cues };
}

function findVideo(procedure, video) {
  if (video === undefined || video === '') {
    const rows = query(`SELECT id, title FROM evergreen_videos WHERE title = ${sqlString(procedure)} COLLATE NOCASE`);
    if (!rows.length) fail(`No evergreen video called "${procedure}" in the ${where} database.`);
    return { table: 'evergreen_videos', id: rows[0].id, label: rows[0].title };
  }
  const rows = query(
    `SELECT v.id, v.title, p.name FROM videos v JOIN procedures p ON p.id = v.procedure_id WHERE p.name = ${sqlString(procedure)} COLLATE NOCASE AND v.order_index = ${Number(video)}`
  );
  if (!rows.length) fail(`${procedure} has no video ${video} in the ${where} database.`);
  return { table: 'videos', id: rows[0].id, label: `${rows[0].name} video ${video} (${rows[0].title})` };
}

if (process.argv.includes('--list')) {
  const rows = [
    ...query(`SELECT p.name AS procedure, v.order_index, v.title, v.captions_vtt IS NOT NULL AS has FROM videos v JOIN procedures p ON p.id = v.procedure_id ORDER BY p.name, v.order_index`),
    ...query(`SELECT 'Evergreen' AS procedure, order_index, title, captions_vtt IS NOT NULL AS has FROM evergreen_videos ORDER BY order_index`),
  ];
  for (const r of rows) console.log(`${r.has ? '✓ captions ' : '✗ none     '} ${r.procedure} · ${r.order_index}. ${r.title}`);
  const missing = rows.filter((r) => !r.has).length;
  console.log(missing ? `\n${missing} video${missing === 1 ? '' : 's'} ${missing === 1 ? 'still needs' : 'still need'} captions.` : '\nEvery video has captions.');
  process.exit(0);
}

const jobs = [];
if (arg('manifest')) {
  const path = arg('manifest');
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  for (const name of ['procedure', 'video', 'file']) if (!header.includes(name)) fail(`The manifest needs a "${name}" column.`);
  for (const r of rows) {
    const get = (n) => (r[header.indexOf(n)] ?? '').trim();
    jobs.push({ procedure: get('procedure'), video: get('video'), file: resolve(dirname(path), get('file')) });
  }
} else {
  const procedure = arg('procedure') ?? arg('evergreen');
  if (!procedure) fail('Usage: npm run captions -- --procedure "Hip Replacement" --video 1 --file hip-1.vtt [--remote]\n   or: --evergreen "Brain Science" --file brain.vtt, --manifest captions.csv, --list');
  const video = arg('evergreen') ? '' : arg('video');
  if (process.argv.includes('--remove')) {
    const v = findVideo(procedure, video);
    runFile(`UPDATE ${v.table} SET captions_vtt = NULL WHERE id = ${sqlString(v.id)};\n`);
    console.log(`Removed the captions from ${v.label}.`);
    process.exit(0);
  }
  if (!arg('file')) fail('Give the caption file with --file.');
  jobs.push({ procedure, video, file: arg('file') });
}

let sql = '';
const done = [];
for (const j of jobs) {
  const v = findVideo(j.procedure, j.video);
  let text;
  try {
    text = readFileSync(j.file, 'utf8');
  } catch {
    fail(`Couldn't read ${j.file}.`);
  }
  const { vtt, cues } = toVtt(text, j.file);
  sql += `UPDATE ${v.table} SET captions_vtt = ${sqlString(vtt)} WHERE id = ${sqlString(v.id)};\n`;
  done.push(`${v.label}: ${cues} caption${cues === 1 ? '' : 's'}`);
}
runFile(sql);
console.log(`${done.join('\n')}\n\nDone (${where} database). Patients can now turn captions on in the player.`);
