// Loads the understanding questions patients answer after each video, from
// a spreadsheet saved as CSV (see questions-template.csv).
//
//   npm run questions -- --file questions.csv [--remote]
//   npm run questions -- --list [--procedure "Hip Replacement"] [--remote]
//
// Columns: procedure, video, question, a, b, c, d, e, answer, explanation
//   procedure    the procedure's name, as in the doctor portal
//   video        the video's number in the set (1, 2, 3 ...)
//   question     the question the patient sees
//   a ... e      the answer choices; leave unused ones empty (2 to 5 choices)
//   answer       the letter of the right choice (A to E)
//   explanation  shown when a patient answers wrongly, before they try again
//
// For every video that appears in the file, its questions are replaced by
// the file's (in the order given). Earlier questions are retired, not
// deleted, so answers patients already gave keep their wording. Videos not
// in the file are left alone. To remove a video's questions entirely, list
// it with --clear "Hip Replacement:3".
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, '--json', `--command=${sql}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0 || r.error) fail(`The database query failed:\n${r.error ? r.error.message : r.stdout}`);
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).flatMap((x) => x.results ?? []);
  } catch {
    fail(`Unexpected answer from wrangler:\n${r.stdout}`);
  }
}

function runFile(sql) {
  const file = '.questions.sql';
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, `--file=${file}`], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } finally {
    unlinkSync(file);
  }
}

function videosFor(procedureName) {
  const rows = query(
    `SELECT v.id, v.order_index, v.title, p.name AS procedure FROM videos v JOIN procedures p ON p.id = v.procedure_id WHERE p.name = ${sqlString(procedureName)} COLLATE NOCASE`
  );
  if (!rows.length) fail(`No procedure called "${procedureName}" with videos in the ${where} database.`);
  return new Map(rows.map((r) => [Number(r.order_index), r]));
}

if (process.argv.includes('--list')) {
  const only = arg('procedure');
  const rows = query(
    `SELECT p.name AS procedure, v.order_index, v.title, q.position, q.prompt, q.choices, q.correct_index
     FROM video_questions q JOIN videos v ON v.id = q.video_id JOIN procedures p ON p.id = v.procedure_id
     WHERE q.retired_at IS NULL ${only ? `AND p.name = ${sqlString(only)} COLLATE NOCASE` : ''}
     ORDER BY p.name, v.order_index, q.position`
  );
  if (!rows.length) console.log(`No questions in the ${where} database${only ? ` for ${only}` : ''}.`);
  let last = '';
  for (const r of rows) {
    const head = `${r.procedure} · video ${r.order_index}: ${r.title}`;
    if (head !== last) console.log(`\n${head}`);
    last = head;
    const choices = JSON.parse(r.choices);
    console.log(`  ${r.position}. ${r.prompt}`);
    choices.forEach((c, i) => console.log(`     ${i === r.correct_index ? '✓' : ' '} ${'ABCDE'[i]}) ${c}`));
  }
  process.exit(0);
}

const clear = arg('clear');
const file = arg('file');
if (!file && !clear) {
  fail('Usage: npm run questions -- --file questions.csv [--remote]\n   or: npm run questions -- --list [--procedure "Hip Replacement"] [--remote]\n   or: npm run questions -- --clear "Hip Replacement:3" [--remote]');
}
const now = new Date().toISOString();

if (clear) {
  const [procName, num] = clear.split(':');
  const video = videosFor(procName).get(Number(num));
  if (!video) fail(`${procName} has no video ${num}.`);
  runFile(`UPDATE video_questions SET retired_at = ${sqlString(now)} WHERE video_id = ${sqlString(video.id)} AND retired_at IS NULL;\n`);
  console.log(`Removed the questions from ${video.procedure} video ${num} (${video.title}).`);
  process.exit(0);
}

const rows = parseCsv(readFileSync(file, 'utf8'));
const header = rows.shift().map((h) => h.trim().toLowerCase());
const col = (name) => header.indexOf(name);
for (const name of ['procedure', 'video', 'question', 'a', 'b', 'answer']) if (col(name) === -1) fail(`The file needs a "${name}" column. See questions-template.csv.`);

const byVideo = new Map();
const problems = [];
const videoCache = new Map();
rows.forEach((r, i) => {
  const line = i + 2;
  const get = (name) => (col(name) === -1 ? '' : (r[col(name)] ?? '').trim());
  const procName = get('procedure');
  const num = Number(get('video'));
  const prompt = get('question');
  const choices = ['a', 'b', 'c', 'd', 'e'].map(get).filter((c) => c !== '');
  const letter = get('answer').toUpperCase();
  const correct = 'ABCDE'.indexOf(letter);
  if (!procName || !Number.isInteger(num) || num < 1) return problems.push(`line ${line}: needs a procedure and a video number`);
  if (!prompt) return problems.push(`line ${line}: the question is empty`);
  if (choices.length < 2) return problems.push(`line ${line}: needs at least two answer choices`);
  if (letter.length !== 1 || correct < 0 || correct >= choices.length) return problems.push(`line ${line}: the answer must be the letter of one of the choices`);
  if (!videoCache.has(procName.toLowerCase())) videoCache.set(procName.toLowerCase(), videosFor(procName));
  const video = videoCache.get(procName.toLowerCase()).get(num);
  if (!video) return problems.push(`line ${line}: ${procName} has no video ${num}`);
  if (!byVideo.has(video.id)) byVideo.set(video.id, { video, questions: [] });
  byVideo.get(video.id).questions.push({ prompt, choices, correct, explanation: get('explanation') || null });
});
if (problems.length) fail(`Nothing was changed. Please fix these lines:\n  ${problems.join('\n  ')}`);
if (!byVideo.size) fail('The file has no questions.');

let sql = '';
for (const { video, questions } of byVideo.values()) {
  sql += `UPDATE video_questions SET retired_at = ${sqlString(now)} WHERE video_id = ${sqlString(video.id)} AND retired_at IS NULL;\n`;
  questions.forEach((q, i) => {
    sql += `INSERT INTO video_questions (id, video_id, position, prompt, choices, correct_index, explanation, created_at) VALUES (` +
      `${sqlString(randomUUID())}, ${sqlString(video.id)}, ${i + 1}, ${sqlString(q.prompt)}, ${sqlString(JSON.stringify(q.choices))}, ${q.correct}, ${sqlString(q.explanation)}, ${sqlString(now)});\n`;
  });
}
runFile(sql);
for (const { video, questions } of byVideo.values()) {
  console.log(`${video.procedure} video ${video.order_index} (${video.title}): ${questions.length} question${questions.length === 1 ? '' : 's'}`);
}
console.log(`\nDone. Patients now answer these after each video (${where} database).`);
