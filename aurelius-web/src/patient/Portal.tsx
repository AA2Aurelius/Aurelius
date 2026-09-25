import type { ReactNode } from 'react';
import { formatDuration, formatHoursLeft } from '../api';
import type { EvergreenVideo } from '../components/PlainPlayer';
import { Thumb } from '../components/Thumb';

export interface PortalVideo {
  id: string;
  title: string;
  order_index: number;
  duration_seconds: number;
  unlocked: boolean;
  complete: boolean;
}

export interface PortalData {
  verified: true;
  patientName: string;
  procedureName: string;
  hoursLeft: number;
  certified: boolean;
  videos: PortalVideo[];
}

export function Portal({ data, evergreen, evergreenBase, player, playingId, onPlay, onPlayEvergreen, onCertificate }: {
  data: PortalData;
  // The video being watched, shown in the main area in place of "Up next".
  player?: ReactNode;
  playingId?: string;
  evergreenBase: string;
  evergreen: EvergreenVideo[];
  onPlay: (v: PortalVideo) => void;
  onPlayEvergreen: (v: EvergreenVideo) => void;
  onCertificate: () => void;
}) {
  const done = data.videos.filter((v) => v.complete).length;
  const expired = data.hoursLeft <= 0;
  const firstName = data.patientName.split(/\s+/)[0];
  const next = !data.certified && !expired ? data.videos.find((v) => v.unlocked && !v.complete) : undefined;

  return (
    <div className="stack-lg">
      <header className="portal-header">
        <p className="muted">Hello {firstName}</p>
        <h1>{data.procedureName}</h1>
        <p>
          Your doctor has asked you to watch these {data.videos.length} videos before your procedure. Watch them in order;
          each one unlocks the next.
        </p>
      </header>

      {data.certified ? (
        <div className="banner success with-action">
          <p><strong>All videos complete.</strong> Your certificate is ready.</p>
          <button className="button" onClick={onCertificate}>View certificate</button>
        </div>
      ) : (
        <div className={`banner ${data.hoursLeft < 12 ? 'warning' : ''}`}>
          <p>
            <strong>{formatHoursLeft(data.hoursLeft)}</strong> to finish the videos with this link.
            {data.hoursLeft < 12 && !expired && ' Please finish soon, or ask your doctor for a new link.'}
          </p>
        </div>
      )}

      <div className="watch-layout">
        <div className="watch-main stack-lg">
          {player ?? (next && (
            <section className="up-next" aria-label="Up next">
              <Thumb src={null} label={`Play video ${next.order_index}: ${next.title}`} onClick={() => onPlay(next)} />
              <div className="up-next-meta">
                <div>
                  <p className="muted" style={{ margin: 0 }}>Up next · Video {next.order_index} of {data.videos.length}</p>
                  <h2 style={{ margin: 0 }}>{next.title}</h2>
                </div>
                <span className="pill blue">{formatDuration(next.duration_seconds)}</span>
              </div>
            </section>
          ))}

          {evergreen.length > 0 && (
            <section>
              <h2>Before you begin</h2>
              <ul className="video-list">
                {evergreen.map((v) => (
                  <li key={v.id} className="video-row">
                    <Thumb src={`${evergreenBase}/${v.playlist}`} small />
                    <div className="video-meta">
                      <span className="video-title">{v.title}</span>
                      <span className="muted">{formatDuration(v.durationSeconds)} · optional</span>
                    </div>
                    <button className="button secondary small" onClick={() => onPlayEvergreen(v)}>Watch</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="watch-side">
          <h2>
            Your videos <span className="muted">({done} of {data.videos.length} complete)</span>
          </h2>
          <ol className="video-list">
            {data.videos.map((v) => {
              const now = playingId === v.id;
              return (
                <li key={v.id} className={`video-row ${v.complete ? 'complete' : ''} ${!v.unlocked ? 'locked' : ''} ${now || (!playingId && next?.id === v.id) ? 'current' : ''}`}>
                  <span className="video-status" aria-hidden="true">{v.complete ? '✓' : v.unlocked ? v.order_index : '🔒'}</span>
                  <div className="video-meta">
                    <span className="video-title">{v.title}</span>
                    <span className="muted">
                      {formatDuration(v.duration_seconds)} · {now ? 'Playing now' : v.complete ? 'Complete' : v.unlocked ? 'Ready to watch' : 'Unlocks after the previous video'}
                    </span>
                  </div>
                  {v.unlocked && !expired && !now && (
                    <button className={`button small ${v.complete ? 'secondary' : ''}`} onClick={() => onPlay(v)}>
                      {v.complete ? 'Watch again' : 'Watch'}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </div>
  );
}
