import { useEffect, useRef } from 'react';

// Cloudflare Turnstile, the bot check that must pass before a code is
// emailed. Without a site key (development) it renders nothing and reports
// an empty token straight away; the API skips the check in development.

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
    __aureliusTurnstile?: Promise<void>;
  }
}

export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '';

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  window.__aureliusTurnstile ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(s);
  });
  return window.__aureliusTurnstile;
}

// `resetKey` changes whenever a fresh token is needed (tokens are single-use).
export function Turnstile({ onToken, onError, resetKey }: {
  onToken: (token: string | null) => void;
  onError: (message: string) => void;
  resetKey: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) {
      onToken('');
      return;
    }
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !el.current || !window.turnstile) return;
        widget.current = window.turnstile.render(el.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t: string) => onToken(t),
          'expired-callback': () => onToken(null),
          'error-callback': () => {
            onToken(null);
            onError('The security check could not be completed. Please reload the page and try again.');
          },
        });
      })
      .catch(() => onError('The security check could not load. Please check your connection and reload the page.'));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resetKey === 0) return;
    onToken(TURNSTILE_SITE_KEY ? null : '');
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return TURNSTILE_SITE_KEY ? <div ref={el} className="turnstile" /> : null;
}
