import { createContext, useContext } from 'react';

export interface Procedure { id: string; name: string; video_count: number; total_seconds: number; first_video_id: string | null; first_video_has_poster?: number }

export interface PatientRow {
  id: string;
  patient_name: string;
  patient_email: string;
  confirmed_at: string | null;
  procedure_id: string;
  procedure_name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  videos_done: number;
  videos_total: number;
  certified_at: string | null;
  hours_left: number;
}

// A procedure's thumbnail comes from its first video's preview playlist.
export function procedureThumb(p: Pick<Procedure, 'first_video_id'>): string | null {
  return p.first_video_id ? `/api/doctor/preview/${encodeURIComponent(p.first_video_id)}/playlist.m3u8` : null;
}

export function procedurePoster(p: Pick<Procedure, 'first_video_id' | 'first_video_has_poster'>): string | null {
  return p.first_video_id && p.first_video_has_poster ? `/api/doctor/preview/${encodeURIComponent(p.first_video_id)}/poster.jpg` : null;
}

export function minutes(totalSeconds: number): string {
  const m = Math.max(1, Math.round(totalSeconds / 60));
  return `${m} min`;
}

// Opens the Invite pop-up from anywhere in the portal, optionally with a
// procedure already chosen.
export const InviteContext = createContext<(procedureId?: string) => void>(() => {});
export const useInvite = () => useContext(InviteContext);
