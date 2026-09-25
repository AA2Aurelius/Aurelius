// Creates a real prescription through the live API, for testing the patient
// pages before the doctor portal exists. Signs in as a doctor (the password
// is asked for, not echoed), prescribes, and prints the patient link. The
// patient also gets the normal email with the link.
//
//   npm run test-prescribe -- --doctor you@clinic.com --email patient@example.com \
//     --name "Test Patient" --procedure "Hip Replacement" [--api http://localhost:8787]
//
// --api defaults to https://aureliuscode.com.
import { createInterface } from 'node:readline';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function promptHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const api = (arg('api') ?? 'https://aureliuscode.com').replace(/\/$/, '');
const doctorEmail = arg('doctor');
const patientEmail = arg('email');
const patientName = arg('name') ?? 'Test Patient';
const procedureName = arg('procedure');
if (!doctorEmail || !patientEmail || !procedureName) {
  fail('Usage: npm run test-prescribe -- --doctor you@clinic.com --email patient@example.com --procedure "Hip Replacement" [--name "Test Patient"] [--api URL]');
}

// The API only accepts state-changing requests that come from its own origin.
const headers = { Origin: api, 'Content-Type': 'application/json' };
let cookie = '';

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${api}${path}`, {
      method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    fail(`Could not reach ${api}: ${err.message}`);
  }
  const set = res.headers.getSetCookie?.() ?? [];
  const session = set.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-aur_ds='));
  if (session) cookie = session;
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) fail(`${method} ${path} failed (${res.status}): ${json?.error ?? res.statusText}`);
  return json;
}

const password = await promptHidden(`Password for ${doctorEmail}: `);
await call('POST', '/api/doctor/login', { email: doctorEmail, password });

const procedures = await call('GET', '/api/doctor/procedures');
const procedure = procedures.find((p) => p.name.toLowerCase() === procedureName.toLowerCase());
if (!procedure) fail(`No procedure named "${procedureName}". Available: ${procedures.map((p) => p.name).join(', ')}`);

const result = await call('POST', '/api/doctor/prescribe', { patient_name: patientName, patient_email: patientEmail, procedure_id: procedure.id });
await call('POST', '/api/doctor/logout', {});

console.log(`Prescribed ${procedure.name} (${procedure.video_count} videos) to ${patientName} <${patientEmail}>.`);
console.log(`Link (also emailed${result.emailSent ? '' : ' — but the email FAILED to send'}), valid until ${result.expiresAt}:`);
console.log(result.watchUrl);
