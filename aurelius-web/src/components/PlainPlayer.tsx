import { useEffect, useRef, useState } from 'react';
import { attachHls } from '../video';

export interface EvergreenVideo { id: string; title: string; order: number; durationSeconds: number; playlist: string }

// The explainer videos aren't part of the consent record, so they play as
// an ordinary video with the browser's own controls. `src` is the playlist URL.
export function PlainPlayer({ title, src, backLabel, onBack }: { title: string; src: string; backLabel: string; onBack: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ref.current) return;
    return attachHls(ref.current, src, { onFatal: setError });
  }, [src]);

  return (
    <div className="player-page">
      <button className="link-button" onClick={onBack}>{backLabel}</button>
      <h1 className="player-title">{title}</h1>
      <div className="player-shell">
        <video ref={ref} controls playsInline preload="metadata" className="player-video" />
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
