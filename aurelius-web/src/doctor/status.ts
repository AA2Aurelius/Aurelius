import { formatHoursLeft } from '../api';

export interface LinkState {
  hours_left: number;
  revoked_at: string | null;
  revoked_reason: string | null;
  certified: boolean;
  videos_done: number;
  videos_total: number;
}

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

// One label per prescription, in the order a doctor cares about.
export function linkStatus(s: LinkState): { label: string; tone: Tone } {
  if (s.certified) return { label: 'Complete', tone: 'success' };
  if (s.revoked_reason === 'resent') return { label: 'Replaced by a new link', tone: 'neutral' };
  if (s.revoked_at) return { label: 'Cancelled', tone: 'neutral' };
  if (s.hours_left <= 0) return { label: 'Link expired', tone: 'danger' };
  if (s.hours_left < 12) return { label: formatHoursLeft(s.hours_left), tone: 'warning' };
  return { label: s.videos_done === 0 ? 'Not started' : 'In progress', tone: 'neutral' };
}
