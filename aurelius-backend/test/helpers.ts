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

export const TURNSTILE_OK = 'turnstile-ok';

// Intercepts calls to Resend and to Turnstile's siteverify (which accepts
// only TURNSTILE_OK); everything else passes through.
export function captureEmails() {
  const sent: SentEmail[] = [];
  const turnstile: string[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init.body);
      sent.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: uuid() }), { status: 200 });
    }
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const form = init.body as FormData;
      const token = String(form.get('response'));
      turnstile.push(token);
      return Response.json({ success: form.get('secret') === 'test-turnstile-secret' && token === TURNSTILE_OK });
    }
    return realFetch(input, init);
  });
  return {
    sent,
    turnstile,
    restore: () => spy.mockRestore(),
    lastTo: (to: string) => [...sent].reverse().find((e) => e.to === to),
  };
}

// ------------------------------------------------------------------ seed

// ------------------------------------------------------------------ clock

// Moves the (fake) clock forward; see test/setup.ts.
export function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

// ------------------------------------------------------------------ seed

export const SEGMENT_MS = 4000;
export const INIT_BYTES = new Uint8Array(200).map((_, i) => (i * 7) % 256);
export const segmentBytes = (idx: number) => new Uint8Array(500).map((_, i) => (i + idx * 31) % 256);

export async function seedDoctor(opts: { password?: string } = {}) {
  const id = uuid();
  const email = `dr-${id.slice(0, 8)}@clinic.test`;
  const password = opts.password ?? 'correct horse battery staple';
  await env.DB.prepare(`INSERT INTO doctors (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, `Dr. ${id.slice(0, 4)}`, email, await hashPassword(password), nowIso()).run();
  return { id, email, password };
}

// A procedure with `count` packaged videos of `durationSeconds` each: an
// init chunk and 4 s media chunks in R2, as npm run package-video produces.
export async function seedProcedure(count = 2, durationSeconds = 60) {
  const procedureId = uuid();
  await env.DB.prepare(`INSERT INTO procedures (id, name, created_at) VALUES (?, ?, ?)`).bind(procedureId, 'Hip Replacement', nowIso()).run();
  const videoIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = uuid();
    const base = `videos/${id}`;
    await env.VIDEOS.put(`${base}/init.mp4`, INIT_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
    await env.DB.prepare(
      `INSERT INTO videos (id, procedure_id, title, order_index, r2_key, duration_seconds, created_at, hls_init_r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, procedureId, `Video ${i}`, i, `${base}/source.mp4`, durationSeconds, nowIso(), `${base}/init.mp4`).run();
    const totalMs = durationSeconds * 1000;
    for (let idx = 0, start = 0; start < totalMs; idx++, start += SEGMENT_MS) {
      const key = `${base}/seg_${idx}.m4s`;
      await env.VIDEOS.put(key, segmentBytes(idx), { httpMetadata: { contentType: 'video/iso.segment' } });
      await env.DB.prepare(`INSERT INTO video_segments (video_id, idx, r2_key, start_ms, duration_ms) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, idx, key, start, Math.min(SEGMENT_MS, totalMs - start)).run();
    }
    videoIds.push(id);
  }
  return { procedureId, videoIds };
}

// An evergreen explainer video (no procedure), packaged like the others.
export async function seedEvergreen(title: string, order: number, durationSeconds = 12) {
  const id = uuid();
  const base = `videos/${id}`;
  await env.VIDEOS.put(`${base}/init.mp4`, INIT_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
  await env.DB.prepare(`INSERT INTO evergreen_videos (id, title, order_index, duration_seconds, hls_init_r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, title, order, durationSeconds, `${base}/init.mp4`, nowIso()).run();
  const totalMs = durationSeconds * 1000;
  for (let idx = 0, start = 0; start < totalMs; idx++, start += SEGMENT_MS) {
    const key = `${base}/seg_${idx}.m4s`;
    await env.VIDEOS.put(key, segmentBytes(idx), { httpMetadata: { contentType: 'video/iso.segment' } });
    await env.DB.prepare(`INSERT INTO evergreen_segments (video_id, idx, r2_key, start_ms, duration_ms) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, idx, key, start, Math.min(SEGMENT_MS, totalMs - start)).run();
  }
  return id;
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
    const sent = await client.post(`/api/watch/${token}/otp/send`, { turnstileToken: TURNSTILE_OK });
    if (sent.status !== 200) throw new Error(`otp send failed: ${sent.status} ${await sent.text()}`);
    const code = /\b(\d{6})\b/.exec(emails.lastTo(patientEmail)!.text)![1];
    const res = await client.post(`/api/watch/${token}/otp/verify`, { code });
    if (res.status !== 200) throw new Error(`otp verify failed: ${res.status}`);
    return client;
  } finally {
    emails.restore();
  }
}

export interface PlayOptions {
  answerChecks?: boolean;              // default true
  visible?: (positionMs: number) => boolean;
  maxTicks?: number;
  stopAtMs?: number;                   // stop once the player reaches this position
}

// A well-behaved player: fetches each chunk once it's released, reports its
// position every 5 s of (fake) real time, and answers attention checks.
export async function playVideo(client: Client, token: string, videoId: string, opts: PlayOptions = {}) {
  const start = await client.post(`/api/watch/${token}/video/${videoId}/playback`);
  if (start.status !== 200 && start.status !== 201) throw new Error(`playback start failed: ${start.status} ${await start.text()}`);
  let st = (await start.json()) as any;
  const base = `/api/watch/${token}/playback/${st.playbackId}`;
  await (await client.fetch(`${base}/init.mp4`)).arrayBuffer();
  const fetched = new Set<number>();
  let position = 0;
  let seq = st.nextSeq;
  const checks: string[] = [];
  for (let tick = 0; tick < (opts.maxTicks ?? 400) && !st.completed; tick++) {
    if (opts.stopAtMs !== undefined && position >= opts.stopAtMs) break;
    for (let i = 0; i <= st.releasedThrough; i++) {
      if (!fetched.has(i)) {
        const r = await client.fetch(`${base}/seg/${i}.m4s`);
        if (r.status !== 200) throw new Error(`segment ${i} failed: ${r.status}`);
        await r.arrayBuffer();
        fetched.add(i);
      }
    }
    let playing = true;
    if (st.attentionCheck) {
      playing = false;
      if (opts.answerChecks !== false && !checks.includes(st.attentionCheck.id)) {
        checks.push(st.attentionCheck.id);
        const a = await client.post(`${base}/attention`, { checkId: st.attentionCheck.id });
        if (a.status !== 200) throw new Error(`attention answer failed: ${a.status}`);
      }
    }
    const visible = opts.visible ? opts.visible(position) : true;
    const hb = await client.post(`${base}/heartbeat`, { seq: seq++, position_ms: position, playing, visible, rate: 1 });
    if (hb.status !== 200) throw new Error(`heartbeat failed: ${hb.status} ${await hb.text()}`);
    st = await hb.json();
    advance(5000);
    const bufferedEnd = Math.min(st.totalMs, (st.releasedThrough + 1) * SEGMENT_MS);
    if (playing && !st.attentionCheck) position = Math.min(position + 5000, bufferedEnd);
  }
  return { playbackId: st.playbackId as string, state: st, base, checksAnswered: checks.length, seq };
}

// Watches a video start to finish; returns the final heartbeat response.
export async function watchAndComplete(client: Client, token: string, _prescriptionId: string, videoId: string) {
  const { state } = await playVideo(client, token, videoId);
  return new Response(JSON.stringify(state), { status: state.completed ? 200 : 409 });
}

export async function events(prescriptionId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM progress_events WHERE prescription_id = ? ORDER BY seq`).bind(prescriptionId).all<any>();
  return results;
}
