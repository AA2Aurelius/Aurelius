import { Env, canonicalJson, sha256Hex } from './lib';

// Hashes of a playback's raw evidence (which chunk was first served when,
// and every heartbeat). They're written into the chained
// `playback_completed` event, and certificate verification recomputes them,
// so editing either table after the fact shows up as tampering.

async function tableHash(env: Env, sql: string, id: string): Promise<{ hash: string; count: number }> {
  const { results } = await env.DB.prepare(sql).bind(id).all();
  return { hash: await sha256Hex(canonicalJson(results)), count: results.length };
}

export async function evidenceHashes(env: Env, playbackId: string) {
  const [serves, beats] = await Promise.all([
    tableHash(env, `SELECT idx, first_served_at FROM segment_serves WHERE playback_id = ? ORDER BY idx`, playbackId),
    tableHash(env, `SELECT seq, received_at, position_ms, playing, visible, rate FROM heartbeats WHERE playback_id = ? ORDER BY seq`, playbackId),
  ]);
  return {
    segments_served: serves.count,
    segment_serves_sha256: serves.hash,
    heartbeats: beats.count,
    heartbeats_sha256: beats.hash,
  };
}
