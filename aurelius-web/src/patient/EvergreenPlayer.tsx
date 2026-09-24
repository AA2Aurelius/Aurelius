import { useEffect, useRef, useState } from 'react';
import { attachHls } from '../video';

export interface EvergreenVideo { id: string; title: string; order: number; durationSeconds: number; playlist: string }

// The explainer videos aren't part of the consent record, so they play as
// an ordinary video with the browser's own controls.
export function EvergreenPlayer({ token, video, onBack }: { token: string; video: EvergreenVideo; onBack: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ref.current) return;
    return attachHls(ref.current, `/api/watch/${encodeURIComponent(token)}/${video.playlist}`, { onFatal: setError });
  }, [token, video.playlist]);

  return (
    <div className="player-page">
      <button className="link-button" onClick={onBack}>← All videos</button>
      <h1 className="player-title">{video.title}</h1>
      <div className="player-shell">
        <video ref={ref} controls playsInline preload="metadata" className="player-video" />
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
