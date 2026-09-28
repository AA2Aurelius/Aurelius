// Thin wrapper over the API on the same origin. Cookies (the patient's
// verified session) travel automatically because everything is same-origin.

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: init.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Could not reach Aurelius. Check your connection and try again.', null);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status}).`, body);
  return body as T;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatHoursLeft(hours: number): string {
  if (hours <= 0) return 'This link has expired';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes left`;
  const h = Math.floor(hours);
  return `${h} hour${h === 1 ? '' : 's'} left`;
}
