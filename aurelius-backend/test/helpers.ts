import { type D1Migration, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as cfEnv } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker from '../src/index';
import { hashPassword } from '../src/password';
import { Env, nowIso, uuid } from '../src/lib';

export type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };
export const env = cfEnv as unknown as TestEnv;

export const ORIGIN = 'https://app.test';

// ------------------------------------------------------------ HTTP client

// A tiny cookie-jar client, one per actor (doctor, patient, stranger).
export class Client {
  cookies = new Map<string, string>();
  ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', this.ip);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const method = init.method ?? (init.json !== undefined ? 'POST' : 'GET');
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin')) headers.set('Origin', ORIGIN);

    const ctx = createExecutionContext();
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { ...init, method, headers, body }) as any, env, ctx);
    await waitOnExecutionContext(ctx);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const [name, value] = pair.split('=');
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    return res;
  }

  post(path: string, json: unknown = {}, headers?: HeadersInit) {
    return this.fetch(path, { method: 'POST', json, headers });
  }
}

// ----------------------------------------------------------------- email

export interface SentEmail { to: string; subject: string; text: string }

// Intercepts calls to Resend; everything else passes through.
export function captureEmails() {
  const sent: SentEmail[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init.body);
      sent.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: uuid() }), { status: 200 });
    }
    return realFetch(input, init);
  });
  return {
    sent,
    restore: () => spy.mockRestore(),
    lastTo: (to: string) => [...sent].reverse().find((e) => e.to === to),
  };
}

// ------------------------------------------------------------------ seed

export const VIDEO_BYTES = new Uint8Array(1000).map((_, i) => i % 256);

export async function seedDoctor(opts: { password?: string } = {}) {
  const id = uuid();
  const email = `dr-${id.slice(0, 8)}@clinic.test`;
  const password = opts.password ?? 'correct horse battery staple';
  await env.DB.prepare(`INSERT INTO doctors (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, `Dr. ${id.slice(0, 4)}`, email, await hashPassword(password), nowIso()).run();
  return { id, email, password };
}

// A procedure with `count` videos of `durationSeconds` each, bytes in R2.
export async function seedProcedure(count = 2, durationSeconds = 60) {
  const procedureId = uuid();
  await env.DB.prepare(`INSERT INTO procedures (id, name, created_at) VALUES (?, ?, ?)`).bind(procedureId, 'Hip Replacement', nowIso()).run();
  const videoIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = uuid();
    const key = `videos/${id}.mp4`;
    await env.VIDEOS.put(key, VIDEO_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
    await env.DB.prepare(
      `INSERT INTO videos (id, procedure_id, title, order_index, r2_key, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, procedureId, `Video ${i}`, i, key, durationSeconds, nowIso()).run();
    videoIds.push(id);
  }
  return { procedureId, videoIds };
}

export async function loginDoctor(doctor: { email: string; password: string }) {
  const client = new Client();
  const res = await client.post('/api/doctor/login', { email: doctor.email, password: doctor.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}

// Full setup: doctor signs in and prescribes; returns the patient's token.
export async function prescribe(opts: { videos?: number; duration?: number; patientEmail?: string } = {}) {
  const emails = captureEmails();
  try {
    const doctor = await seedDoctor();
    const doctorClient = await loginDoctor(doctor);
    const { procedureId, videoIds } = await seedProcedure(opts.videos ?? 2, opts.duration ?? 60);
    const patientEmail = opts.patientEmail ?? `patient-${uuid().slice(0, 8)}@mail.test`;
    const res = await doctorClient.post('/api/doctor/prescribe', { patient_name: 'Jane Q Smith', patient_email: patientEmail, procedure_id: procedureId });
    if (res.status !== 201) throw new Error(`prescribe failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { prescriptionId: string; watchUrl: string };
    const token = body.watchUrl.split('/watch/')[1];
    return { doctor, doctorClient, procedureId, videoIds, patientEmail, token, prescriptionId: body.prescriptionId };
  } finally {
    emails.restore();
  }
}

// Requests and enters a one-time code; returns the verified patient client.
export async function verifiedPatient(token: string, patientEmail: string) {
  const emails = captureEmails();
  try {
    const client = new Client();
    const sent = await client.post(`/api/watch/${token}/otp/send`);
    if (sent.status !== 200) throw new Error(`otp send failed: ${sent.status} ${await sent.text()}`);
    const code = /\b(\d{6})\b/.exec(emails.lastTo(patientEmail)!.text)![1];
    const res = await client.post(`/api/watch/${token}/otp/verify`, { code });
    if (res.status !== 200) throw new Error(`otp verify failed: ${res.status}`);
    return client;
  } finally {
    emails.restore();
  }
}

// Stand-in for waiting: moves a video's first-stream time into the past.
export async function backdateStart(prescriptionId: string, videoId: string, seconds: number) {
  await env.DB.prepare(`UPDATE video_progress SET started_at = ? WHERE prescription_id = ? AND video_id = ?`)
    .bind(new Date(Date.now() - seconds * 1000).toISOString(), prescriptionId, videoId).run();
}

// Streams, "waits" and completes a video.
export async function watchAndComplete(client: Client, token: string, prescriptionId: string, videoId: string, duration = 60) {
  const s = await client.fetch(`/api/watch/${token}/video/${videoId}/stream`, { headers: { Range: 'bytes=0-' } });
  await s.arrayBuffer();
  await backdateStart(prescriptionId, videoId, duration);
  return client.post(`/api/watch/${token}/video/${videoId}/complete`);
}

export async function events(prescriptionId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM progress_events WHERE prescription_id = ? ORDER BY seq`).bind(prescriptionId).all<any>();
  return results;
}
