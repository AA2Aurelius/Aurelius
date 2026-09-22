// Creates a doctor account. There is deliberately no public sign-up route.
//
//   npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com [--remote]
//
// Prompts for the password (not echoed), hashes it the same way the Worker
// does (PBKDF2-SHA256, 100,000 iterations), and inserts the row with
// `wrangler d1 execute` -- into the local database by default, or the
// deployed one with --remote.
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
if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com [--remote]');
  process.exit(1);
}

const password = await promptHidden('Password (min 12 characters): ');
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

const file = '.create-doctor.sql';
writeFileSync(file,
  `INSERT INTO doctors (id, name, email, password_hash, created_at) VALUES (` +
  `${sqlString(randomUUID())}, ${sqlString(name)}, ${sqlString(email)}, ${sqlString(passwordHash)}, ${sqlString(new Date().toISOString())});\n`,
  { mode: 0o600 });
try {
  const target = process.argv.includes('--remote') ? '--remote' : '--local';
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, `--file=${file}`], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`Created doctor ${email}.`);
} finally {
  unlinkSync(file);
}
