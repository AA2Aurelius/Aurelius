// Hides a doctor's invites from the portal, e.g. the test invites made
// before launch. Nothing is deleted: the viewing records and certificates
// can't be (by design), and certificates stay verifiable. Links that are
// still open are closed, so they stop working and get no reminders.
//
//   npm run archive-invites -- --email doctor@clinic.com [--remote]
//   npm run archive-invites -- --email doctor@clinic.com --restore [--remote]
//
// Archives every invite that doctor has made so far. It shows how many
// first and asks you to type "yes". Archived invites are still listed in
// the portal under Invites History > Filter by > Archived.
//
// --restore puts them all back in the main list, and reopens the links it
// had closed (those still within their 48 hours work again).
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const email = arg('email')?.trim().toLowerCase();
const target = process.argv.includes('--remote') ? '--remote' : '--local';
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run archive-invites -- --email doctor@clinic.com [--remote]');
  process.exit(1);
}
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

function query(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'aurelius-db', target, '--json', `--command=${sql}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // With --json, wrangler reports errors on stdout, so show it on failure.
  if (r.status !== 0 || r.error) {
    console.error(`The database query failed:\n${r.error ? r.error.message : r.stdout}`);
    process.exit(r.status || 1);
  }
  try {
    return JSON.parse(r.stdout)[0].results;
  } catch {
    console.error(`Unexpected answer from wrangler:\n${r.stdout}`);
    process.exit(1);
  }
}

const doctor = query(`SELECT id, name FROM doctors WHERE email = ${sqlString(email)}`)[0];
if (!doctor) {
  console.error(`No doctor with the email ${email} (${target.slice(2)} database).`);
  process.exit(1);
}
const now = new Date().toISOString();
const id = sqlString(doctor.id);

if (process.argv.includes('--restore')) {
  const [{ n }] = query(`SELECT COUNT(*) AS n FROM prescriptions WHERE doctor_id = ${id} AND archived_at IS NOT NULL`);
  if (!n) {
    console.log(`${doctor.name} has no archived invites.`);
    process.exit(0);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`Put ${n === 1 ? 'the 1 archived invite' : `all ${n} archived invites`} back in ${doctor.name}'s Patients list (${target.slice(2)} database)? Type "yes": `, (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Nothing changed.');
      return;
    }
    query(
      `UPDATE prescriptions SET revoked_at = NULL, revoked_reason = NULL WHERE doctor_id = ${id} AND revoked_reason = 'archived'; ` +
        `UPDATE prescriptions SET archived_at = NULL WHERE doctor_id = ${id} AND archived_at IS NOT NULL`
    );
    console.log(`Restored ${n} invite${n === 1 ? '' : 's'}. They're back in ${doctor.name}'s Patients list.`);
  });
} else {
  const [{ n }] = query(`SELECT COUNT(*) AS n FROM prescriptions WHERE doctor_id = ${sqlString(doctor.id)} AND archived_at IS NULL`);
  if (!n) {
    console.log(`${doctor.name} has no invites to archive.`);
    process.exit(0);
  }

  const invites = `${n} invite${n === 1 ? '' : 's'}`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`Archive ${n === 1 ? 'the 1 invite' : `all ${n} invites`} ${doctor.name} has made so far (${target.slice(2)} database)? Type "yes": `, (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Nothing changed.');
      return;
    }
    query(
      `UPDATE prescriptions SET revoked_at = ${sqlString(now)}, revoked_reason = 'archived' ` +
        `WHERE doctor_id = ${id} AND archived_at IS NULL AND revoked_at IS NULL; ` +
        `UPDATE prescriptions SET archived_at = ${sqlString(now)} WHERE doctor_id = ${id} AND archived_at IS NULL`
    );
    console.log(`Archived ${invites}. ${doctor.name}'s Patients list now starts empty; certificates can still be verified.`);
  });
}
