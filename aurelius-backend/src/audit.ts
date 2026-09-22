import { Env, canonicalJson, nowIso, sha256Hex, uuid } from './lib';

// Tamper-evident audit log. Every event for a prescription is chained:
//   hash = SHA-256(prev_hash + "\n" + canonicalJson(row fields))
// starting from GENESIS_HASH. Changing, removing or reordering any row
// changes every hash after it, so a certificate that records the head hash
// pins the whole history up to that point.

export const GENESIS_HASH = '0'.repeat(64);
export const CHAIN_ALGORITHM = 'sha256-chain-v1';

export type EventType =
  | 'prescribed'
  | 'link_sent'
  | 'link_send_failed'
  | 'otp_sent'
  | 'otp_verified'
  | 'otp_failed'
  | 'stream_start'
  | 'play'
  | 'pause'
  | 'seek_attempt'
  | 'complete'
  | 'complete_rejected'
  | 'certificate_issued'
  | 'reminder_12h';

export interface EventInput {
  prescriptionId: string;
  videoId?: string | null;
  type: EventType;
  ip?: string | null;
  meta?: Record<string, unknown> | null;
}

interface EventRow {
  id: string;
  prescription_id: string;
  seq: number;
  video_id: string | null;
  event_type: string;
  server_time: string;
  client_ip: string | null;
  meta: string | null;
}

async function rowHash(prevHash: string, row: EventRow): Promise<string> {
  return sha256Hex(`${prevHash}\n${canonicalJson(row)}`);
}

// The exact fields covered by the hash, in a fixed shape. Used both when
// writing and when re-verifying rows read back from D1.
function hashedFields(r: EventRow): EventRow {
  return {
    id: r.id,
    prescription_id: r.prescription_id,
    seq: r.seq,
    video_id: r.video_id ?? null,
    event_type: r.event_type,
    server_time: r.server_time,
    client_ip: r.client_ip ?? null,
    meta: r.meta ?? null,
  };
}

async function chainHead(env: Env, prescriptionId: string): Promise<{ seq: number; hash: string }> {
  const last = await env.DB.prepare(
    `SELECT seq, hash FROM progress_events WHERE prescription_id = ? ORDER BY seq DESC LIMIT 1`
  ).bind(prescriptionId).first<{ seq: number; hash: string }>();
  return last ?? { seq: 0, hash: GENESIS_HASH };
}

// Builds the INSERT for the next event in the chain without running it, so
// callers can put it in a D1 batch (one transaction) with the state change
// it records. With `onlyIfPreviousChanged`, the insert happens only if the
// statement just before it in the batch modified exactly one row -- so a
// conditional UPDATE and the event recording it succeed or no-op together.
export async function prepareEvent(
  env: Env,
  input: EventInput,
  opts: { head?: { seq: number; hash: string }; onlyIfPreviousChanged?: boolean } = {}
): Promise<{ stmt: D1PreparedStatement; row: EventRow; hash: string }> {
  const head = opts.head ?? (await chainHead(env, input.prescriptionId));
  const row: EventRow = hashedFields({
    id: uuid(),
    prescription_id: input.prescriptionId,
    seq: head.seq + 1,
    video_id: input.videoId ?? null,
    event_type: input.type,
    server_time: nowIso(),
    client_ip: input.ip ?? null,
    meta: input.meta ? canonicalJson(input.meta) : null,
  });
  const hash = await rowHash(head.hash, row);
  const values = [row.id, row.prescription_id, row.seq, row.video_id, row.event_type, row.server_time, row.client_ip, row.meta, head.hash, hash];
  const stmt = opts.onlyIfPreviousChanged
    ? env.DB.prepare(
        `INSERT INTO progress_events (id, prescription_id, seq, video_id, event_type, server_time, client_ip, meta, prev_hash, hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
      ).bind(...values)
    : env.DB.prepare(
        `INSERT INTO progress_events (id, prescription_id, seq, video_id, event_type, server_time, client_ip, meta, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(...values);
  return { stmt, row, hash };
}

export function isSeqConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: progress_events\.(prescription_id|seq)/.test(String((err as any)?.message ?? err));
}

// Runs `build` (which should include a prepareEvent statement) in a batch,
// retrying if a concurrent writer took the same sequence number.
export async function withChainRetry<T>(build: () => Promise<T>, run: (built: T) => Promise<void>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    const built = await build();
    try {
      await run(built);
      return built;
    } catch (err) {
      if (!isSeqConflict(err) || i >= attempts - 1) throw err;
    }
  }
}

// Appends a single event on its own.
export async function logEvent(env: Env, input: EventInput): Promise<void> {
  await withChainRetry(() => prepareEvent(env, input), async ({ stmt }) => { await stmt.run(); });
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  headHash: string;
  error?: string;
}

// Re-walks the chain from the start and recomputes every hash. With
// `upToSeq`, only the first `upToSeq` events are checked (what a certificate
// covers); later events don't affect the result.
export async function verifyChain(env: Env, prescriptionId: string, upToSeq?: number): Promise<ChainCheck> {
  const { results } = await env.DB.prepare(
    `SELECT id, prescription_id, seq, video_id, event_type, server_time, client_ip, meta, prev_hash, hash
     FROM progress_events WHERE prescription_id = ? ${upToSeq !== undefined ? 'AND seq <= ?' : ''} ORDER BY seq`
  ).bind(...(upToSeq !== undefined ? [prescriptionId, upToSeq] : [prescriptionId])).all<EventRow & { prev_hash: string; hash: string }>();

  let prev = GENESIS_HASH;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.seq !== i + 1) return { ok: false, count: i, headHash: prev, error: `missing event at seq ${i + 1}` };
    if (r.prev_hash !== prev) return { ok: false, count: i, headHash: prev, error: `broken link at seq ${r.seq}` };
    const expected = await rowHash(prev, hashedFields(r));
    if (expected !== r.hash) return { ok: false, count: i, headHash: prev, error: `hash mismatch at seq ${r.seq}` };
    prev = r.hash;
  }
  if (upToSeq !== undefined && results.length !== upToSeq) {
    return { ok: false, count: results.length, headHash: prev, error: `expected ${upToSeq} events, found ${results.length}` };
  }
  return { ok: true, count: results.length, headHash: prev };
}
