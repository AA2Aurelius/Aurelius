import { useEffect, useRef, useState } from 'react';
import { attachHls } from '../video';

export interface EvergreenVideo { id: string; title: string; order: number; durationSeconds: number; playlist: string }

// An ordinary video with the browser's own controls, for videos that aren't
// part of the consent record (the evergreen explainers, doctors' previews).
// `src` is the playlist URL.
export function VideoFrame({ src, autoPlay }: { src: string; autoPlay?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    setError('');
    const detach = attachHls(v, src, { onFatal: setError });
    if (autoPlay) v.play().catch(() => {});
    return detach;
  }, [src, autoPlay]);
  return (
    <>
      <div className="player-shell">
        <video ref={ref} controls playsInline preload="metadata" className="player-video" />
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

export function PlainPlayer({ title, src, backLabel, onBack }: { title: string; src: string; backLabel: string; onBack: () => void }) {
  return (
    <div className="player-page">
      <button className="link-button" onClick={onBack}>{backLabel}</button>
      <h1 className="player-title">{title}</h1>
      <VideoFrame src={src} />
    </div>
  );
}
