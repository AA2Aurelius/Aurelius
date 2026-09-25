import { formatDuration, formatHoursLeft } from '../api';
import type { EvergreenVideo } from '../components/PlainPlayer';

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

export function Portal({ data, evergreen, onPlay, onPlayEvergreen, onCertificate }: {
  data: PortalData;
  evergreen: EvergreenVideo[];
  onPlay: (v: PortalVideo) => void;
  onPlayEvergreen: (v: EvergreenVideo) => void;
  onCertificate: () => void;
}) {
  const done = data.videos.filter((v) => v.complete).length;
  const expired = data.hoursLeft <= 0;
  const firstName = data.patientName.split(/\s+/)[0];

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

      {evergreen.length > 0 && (
        <section>
          <h2>Before you begin</h2>
          <ul className="video-list">
            {evergreen.map((v) => (
              <li key={v.id} className="video-row">
                <div className="video-meta">
                  <span className="video-title">{v.title}</span>
                  <span className="muted">{formatDuration(v.durationSeconds)} · optional</span>
                </div>
                <button className="button secondary" onClick={() => onPlayEvergreen(v)}>Watch</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>
          Your videos <span className="muted">({done} of {data.videos.length} complete)</span>
        </h2>
        <ol className="video-list">
          {data.videos.map((v) => (
            <li key={v.id} className={`video-row ${v.complete ? 'complete' : ''} ${!v.unlocked ? 'locked' : ''}`}>
              <span className="video-status" aria-hidden="true">{v.complete ? '✓' : v.unlocked ? v.order_index : '🔒'}</span>
              <div className="video-meta">
                <span className="video-title">{v.title}</span>
                <span className="muted">
                  {formatDuration(v.duration_seconds)} · {v.complete ? 'Complete' : v.unlocked ? 'Ready to watch' : 'Unlocks after the previous video'}
                </span>
              </div>
              {v.unlocked && !expired && (
                <button className={v.complete ? 'button secondary' : 'button'} onClick={() => onPlay(v)}>
                  {v.complete ? 'Watch again' : 'Watch'}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
