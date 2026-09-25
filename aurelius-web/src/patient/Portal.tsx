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
  poster: string | null;
}

export interface PortalData {
  verified: true;
  patientName: string;
  procedureName: string;
  doctorName: string | null;
  hoursLeft: number;
  certified: boolean;
  videos: PortalVideo[];
}

export function Portal({ data, evergreen, evergreenBase: base, player, playingId, onPlay, onPlayEvergreen, onCertificate }: {
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
        data.hoursLeft < 12 ? (
          <div className={`alert-12h ${expired ? 'expired' : ''}`} role="status">
            {expired ? (
              <p style={{ margin: 0 }}><strong>This link has expired.</strong> Please ask your doctor's office for a new link.</p>
            ) : (
              <p style={{ margin: 0 }}>
                <strong>⏰ Only {formatHoursLeft(data.hoursLeft).replace(' left', '')} left</strong> to finish your videos
                ({done} of {data.videos.length} done). Please finish soon, or ask your doctor for a new link.
              </p>
            )}
          </div>
        ) : (
          <div className="banner">
            <p>
              <strong>{formatHoursLeft(data.hoursLeft)}</strong> to finish the videos with this link.
            </p>
          </div>
        )
      )}

      {evergreen.length > 0 && (
        <section className="stack">
          <h2 style={{ margin: 0 }}>Before you begin <span className="muted" style={{ fontWeight: 600, fontSize: '0.9rem' }}>· optional</span></h2>
          <div className="evergreen-row">
            {evergreen.map((v) => (
              <article key={v.id} className="vid-card">
                <Thumb src={`${base}/${v.playlist}`} poster={v.poster && `${base}/${v.poster}`} label={`Watch ${v.title}`} onClick={() => onPlayEvergreen(v)} />
                <div className="vid-card-body">
                  <span className="vid-category">Aurelius Code</span>
                  <h3>{v.title}</h3>
                  <div className="vid-card-foot">
                    <span className="muted">{formatDuration(v.durationSeconds)}</span>
                    <button className="button secondary small" onClick={() => onPlayEvergreen(v)}>Watch</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="watch-layout">
        <div className="watch-main stack-lg">
          {player ?? (next && (
            <section className="up-next" aria-label="Up next">
              <Thumb src={null} poster={next.poster && `${base}/${next.poster}`} label={`Play video ${next.order_index}: ${next.title}`} onClick={() => onPlay(next)} />
              <div className="up-next-meta">
                <div>
                  <p className="muted" style={{ margin: 0 }}>Up next · Video {next.order_index} of {data.videos.length}</p>
                  <h2 style={{ margin: 0 }}>{next.title}</h2>
                </div>
                <span className="pill blue">{formatDuration(next.duration_seconds)}</span>
              </div>
            </section>
          ))}

        </div>

        <div className="watch-side-col">
        <aside className="info-card" aria-label="Info">
          <div className="info-card-body">
            <h2>Info</h2>
            {data.doctorName && (
              <>
                <p className="info-kicker">These videos were shared with you by</p>
                <p className="info-doctor">{data.doctorName}</p>
              </>
            )}
            <p className="muted">
              Watch all {data.videos.length} in order. Each one unlocks the next, and your certificate is ready when the last one
              is done.
            </p>
          </div>
          <div className={`info-timer ${data.certified ? 'done' : expired ? 'expired' : ''}`}>
            {data.certified ? '✓ All videos complete' : expired ? 'Link expired' : <>◷ {timeLeft(data.hoursLeft)} <small>left</small></>}
          </div>
        </aside>
        <aside className="watch-side">
          <h2>
            Your videos <span className="muted">({done} of {data.videos.length} complete)</span>
          </h2>
          <ol className="video-list">
            {data.videos.map((v) => {
              const now = playingId === v.id;
              return (
                <li key={v.id} className={`video-row ${v.complete ? 'complete' : ''} ${!v.unlocked ? 'locked' : ''} ${now || (!playingId && next?.id === v.id) ? 'current' : ''}`}>
                  {v.poster ? (
                    <Thumb src={null} poster={`${base}/${v.poster}`} small badge={v.complete ? '✓' : v.unlocked ? String(v.order_index) : '🔒'} />
                  ) : (
                    <span className="video-status" aria-hidden="true">{v.complete ? '✓' : v.unlocked ? v.order_index : '🔒'}</span>
                  )}
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
    </div>
  );
}

// "21H 30M", as on the wireframe's timer bar.
function timeLeft(hours: number): string {
  const total = Math.max(0, Math.floor(hours * 60));
  return `${Math.floor(total / 60)}H ${String(total % 60).padStart(2, '0')}M`;
}
