import { randomBytes } from './lib';

// Server-paced playback. The rules, in one place:
//
//  * `allowed_ms` is how far into the video the server lets playback get.
//    It starts at 0 and grows only with real elapsed time between
//    heartbeats, and only while the player reported playing, the tab was
//    visible, and no attention check is outstanding. So it can never run
//    faster than 1x, and paused or hidden time can't be banked.
//  * The playlist lists only chunks starting before allowed_ms + LEAD_MS.
//    Chunks past that don't exist as far as the player is concerned, and
//    requesting one directly is refused and logged as a blocked seek.
//  * The server marks the video complete on its own once allowed_ms has
//    reached the end, every chunk has been served, every attention check has
//    been passed, and the player reports it has reached the end.

export const HEARTBEAT_INTERVAL_MS = 5_000;
// Released ahead of allowed_ms so playback starts and continues smoothly
// (3 chunks of 4 s).
export const LEAD_MS = 12_000;
// A gap between heartbeats longer than this earns no more credit than this.
export const MAX_CREDIT_GAP_MS = 15_000;
// allowed_ms may run at most this far past the position the player reports
// (heartbeat timing jitter); stops credit piling up while the player stalls.
export const POSITION_TOLERANCE_MS = 4_000;
// How long the patient has to answer an attention check.
export const CHECK_RESPONSE_MS = 60_000;
// The player must report a position within this of the end.
export const END_TOLERANCE_MS = 5_000;

export interface Segment {
  idx: number;
  start_ms: number;
  duration_ms: number;
}

// Highest chunk index the playlist may list for a given allowed_ms.
export function releasedThrough(segments: Segment[], allowedMs: number): number {
  let through = 0;
  for (const s of segments) if (s.start_ms < allowedMs + LEAD_MS) through = s.idx;
  return through;
}

export function releasedEndMs(segments: Segment[], through: number): number {
  const s = segments[through];
  return s ? s.start_ms + s.duration_ms : 0;
}

export interface AccrualState {
  allowed_ms: number;
  total_ms: number;
  last_heartbeat_at: string | null;
  last_playing: boolean;
  last_visible: boolean;
}

export interface Accrual {
  allowed_ms: number;
  credited_ms: number;   // wall time counted as watching in this interval
  playing_ms: number;    // wall time the player said it was playing
  hidden_ms: number;     // ...while the tab was hidden
}

// Credit for the interval since the previous heartbeat, judged by the state
// the player reported at the *start* of that interval.
export function accrue(state: AccrualState, positionMs: number, nowMs: number, blockAtMs: number | null): Accrual {
  const dt = state.last_heartbeat_at
    ? Math.max(0, Math.min(nowMs - new Date(state.last_heartbeat_at).getTime(), MAX_CREDIT_GAP_MS))
    : 0;
  const playing = state.last_playing ? dt : 0;
  const hidden = state.last_playing && !state.last_visible ? dt : 0;
  const credit = state.last_playing && state.last_visible ? dt : 0;

  let allowed = state.allowed_ms + credit;
  allowed = Math.min(allowed, positionMs + POSITION_TOLERANCE_MS);
  if (blockAtMs !== null) allowed = Math.min(allowed, blockAtMs);
  allowed = Math.min(allowed, state.total_ms);
  allowed = Math.max(allowed, state.allowed_ms); // never goes backwards

  return { allowed_ms: allowed, credited_ms: allowed - state.allowed_ms, playing_ms: playing, hidden_ms: hidden };
}

function randomUnit(): number {
  return new DataView(randomBytes(4).buffer).getUint32(0) / 2 ** 32;
}

// Where attention checks go: one in videos under a minute, otherwise one in
// each half of the 10%-90% range. Chosen when the playback starts and never
// sent to the client ahead of time.
export function pickCheckTimes(totalMs: number): number[] {
  const lo = totalMs * 0.1;
  const hi = totalMs * 0.9;
  if (totalMs < 60_000) return [Math.round(lo + randomUnit() * (hi - lo))];
  const mid = (lo + hi) / 2;
  return [Math.round(lo + randomUnit() * (mid - lo)), Math.round(mid + randomUnit() * (hi - mid))];
}

export function hlsPlaylist(segments: Segment[], through: number, complete: boolean): string {
  const target = Math.ceil(Math.max(...segments.map((s) => s.duration_ms)) / 1000);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    // EVENT: the player treats the list as growing and keeps re-fetching it.
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (const s of segments) {
    if (s.idx > through) break;
    lines.push(`#EXTINF:${(s.duration_ms / 1000).toFixed(3)},`, `seg/${s.idx}.m4s`);
  }
  if (complete) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
