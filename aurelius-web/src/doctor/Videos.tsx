import { useEffect, useState } from 'react';
import { ApiError, formatDuration } from '../api';
import { PlainPlayer, type EvergreenVideo } from '../components/PlainPlayer';
import { doctorApi } from './nav';

interface Procedure { id: string; name: string; video_count: number }

// The video library: the procedure sets a doctor can prescribe, and the
// "Before you begin" videos every patient sees, which can be previewed here.
export function Videos() {
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [evergreen, setEvergreen] = useState<EvergreenVideo[]>([]);
  const [playing, setPlaying] = useState<EvergreenVideo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([doctorApi<Procedure[]>('/procedures'), doctorApi<{ videos: EvergreenVideo[] }>('/evergreen')])
      .then(([p, e]) => {
        setProcedures(p);
        setEvergreen(e.videos);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the videos.'));
  }, []);

  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!procedures) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  if (playing) {
    return <PlainPlayer title={playing.title} src={`/api/doctor/${playing.playlist}`} backLabel="← Videos" onBack={() => setPlaying(null)} />;
  }

  return (
    <div className="stack-lg">
      <section className="stack">
        <h1>Videos</h1>
        <h2>Procedures</h2>
        <ul className="video-list">
          {procedures.map((p) => (
            <li key={p.id} className="video-row">
              <div className="video-meta">
                <span className="video-title">{p.name}</span>
                <span className="muted">{p.video_count} video{p.video_count === 1 ? '' : 's'}, watched in order</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {evergreen.length > 0 && (
        <section className="stack">
          <h2>Before you begin</h2>
          <p className="muted">Every patient can watch these before their procedure's videos. They're optional and aren't part of the certificate.</p>
          <ul className="video-list">
            {evergreen.map((v) => (
              <li key={v.id} className="video-row">
                <div className="video-meta">
                  <span className="video-title">{v.title}</span>
                  <span className="muted">{formatDuration(v.durationSeconds)}</span>
                </div>
                <button className="button secondary" onClick={() => setPlaying(v)}>Preview</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
