// Creates a doctor account, or resets an existing doctor's password. There
// is deliberately no public sign-up or password-reset route.
//
//   npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com [--remote]
//   npm run create-doctor -- --reset --email jane@clinic.com [--remote]
//
// Prompts for the password (not echoed), hashes it the same way the Worker
// does (PBKDF2-SHA256, 100,000 iterations), and writes it with
// `wrangler d1 execute` -- to the local database by default, or the
// deployed one with --remote.
//
// --reset keeps the account (and so its link to every prescription and
// audit record) and only replaces the password. It also signs the doctor out
// of every open session and clears the failed-sign-in lockout for the email.
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ITERATIONS = 100_000;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// One readline for every prompt, echoing only the prompt text itself.
// Lines are queued so input typed (or piped) ahead of a prompt isn't lost.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let currentPrompt = '';
rl._writeToOutput = (s) => { if (s.includes(currentPrompt)) rl.output.write(s); };
const lines = [];
const waiting = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on('close', () => { while (waiting.length) waiting.shift()(''); });

function promptHidden(question) {
  currentPrompt = question;
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (answer) => { process.stdout.write('\n'); resolve(answer); };
    lines.length ? done(lines.shift()) : waiting.push(done);
  });
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

const name = arg('name');
const email = arg('email')?.trim().toLowerCase();
const reset = process.argv.includes('--reset');
const target = process.argv.includes('--remote') ? '--remote' : '--local';
if ((!reset && !name) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com [--remote]');
  console.error('   or: npm run create-doctor -- --reset --email jane@clinic.com [--remote]');
  process.exit(1);
}

if (reset) {
  // Fail before asking for a password if there's no such account.
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, '--json',
    `--command=SELECT name FROM doctors WHERE email = ${sqlString(email)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  let rows = [];
  try {
    rows = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).flatMap((x) => x.results ?? []);
  } catch {
    console.error(`Unexpected output from wrangler:\n${r.stdout}`);
    process.exit(1);
  }
  if (rows.length === 0) {
    console.error(`No doctor account with the email ${email}${target === '--remote' ? '' : ' in the local database (add --remote for the live one)'}.`);
    process.exit(1);
  }
  console.log(`Resetting the password for ${rows[0].name} <${email}>.`);
}

const password = await promptHidden(`${reset ? 'New password' : 'Password'} (min 12 characters): `);
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
if ((await promptHidden('Confirm password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}
rl.close();

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const passwordHash = `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;

const now = new Date().toISOString();
const sql = reset
  ? `UPDATE doctors SET password_hash = ${sqlString(passwordHash)} WHERE email = ${sqlString(email)};\n` +
    // Sign out everywhere: anyone holding an old session loses it now.
    `UPDATE doctor_sessions SET revoked_at = ${sqlString(now)} WHERE revoked_at IS NULL ` +
    `AND doctor_id = (SELECT id FROM doctors WHERE email = ${sqlString(email)});\n` +
    `DELETE FROM rate_limits WHERE key = ${sqlString(`login:email:${email}`)};\n`
  : `INSERT INTO doctors (id, name, email, password_hash, created_at) VALUES (` +
    `${sqlString(randomUUID())}, ${sqlString(name)}, ${sqlString(email)}, ${sqlString(passwordHash)}, ${sqlString(now)});\n`;

const file = '.create-doctor.sql';
writeFileSync(file, sql, { mode: 0o600 });
try {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, `--file=${file}`], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(reset ? `Password reset for ${email}. Any signed-in sessions were ended.` : `Created doctor ${email}.`);
} finally {
  unlinkSync(file);
}
