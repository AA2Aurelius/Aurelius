import { MouseEvent, ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../api';

// Navigation inside the doctor portal without full page loads, so the
// signed-in state and loaded data survive moving between pages.

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

// A one-time message for the next page, e.g. "A new link was emailed".
let flash = '';
export function setFlash(message: string) {
  flash = message;
}
// Read on mount and cleared after, so React's double render in development
// doesn't lose it.
export function useFlash(): [string, (s: string) => void] {
  const [message, setMessage] = useState(() => flash);
  useEffect(() => {
    flash = '';
  }, []);
  return [message, setMessage];
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onChange = () => setPath(location.pathname);
    addEventListener('popstate', onChange);
    return () => removeEventListener('popstate', onChange);
  }, []);
  return path;
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle new-tab clicks.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} className={className} onClick={onClick}>{children}</a>;
}

// Calls to /api/doctor. A 401 means the session ended (30 minutes idle, 12
// hours at most, or signed out elsewhere); the portal then shows sign-in.
let onSignedOut: () => void = () => {};
export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

export async function doctorApi<T = any>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  try {
    return await api<T>(`/api/doctor${path}`, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) onSignedOut();
    throw err;
  }
}
