import { useEffect, useState } from 'react';
import { ApiError, formatDuration } from '../api';
import { PlainPlayer, type EvergreenVideo } from '../components/PlainPlayer';
import { Thumb } from '../components/Thumb';
import { InviteIcon } from '../components/icons';
import { minutes, procedureThumb, useInvite, type PatientRow, type Procedure } from './library';
import { Link, doctorApi, navigate } from './nav';

// The video library: one card per procedure (the set of videos a patient is
// sent), with how many of this doctor's patients have it and an Invite
// button; then the "Before you begin" videos every patient can watch.
export function Videos() {
  const invite = useInvite();
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [evergreen, setEvergreen] = useState<EvergreenVideo[]>([]);
  const [playing, setPlaying] = useState<EvergreenVideo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      doctorApi<Procedure[]>('/procedures'),
      doctorApi<PatientRow[]>('/patients'),
      doctorApi<{ videos: EvergreenVideo[] }>('/evergreen'),
    ])
      .then(([p, pts, e]) => {
        setProcedures(p);
        setPatients(pts);
        setEvergreen(e.videos);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the videos.'));
  }, []);

  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!procedures) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  if (playing) {
    return <PlainPlayer title={playing.title} src={`/api/doctor/${playing.playlist}`} backLabel="← All videos" onBack={() => setPlaying(null)} />;
  }

  const activeCount = (id: string) => patients.filter((r) => r.procedure_id === id && !r.revoked_at).length;
  const open = (id: string) => navigate(`/doctor/procedures/${encodeURIComponent(id)}`);

  return (
    <div className="stack-lg">
      <div className="row">
        <h1>All videos</h1>
        <button className="button" onClick={() => invite()}><InviteIcon /> Invite patient</button>
      </div>

      {procedures.length === 0 ? (
        <div className="card"><p>No procedures yet. Videos are added with <code>npm run package-video</code>.</p></div>
      ) : (
        <div className="library-grid">
          {procedures.map((p) => {
            const n = activeCount(p.id);
            return (
              <article key={p.id} className="lib-card">
                <Thumb src={procedureThumb(p)} label={`Open ${p.name}`} onClick={() => open(p.id)} />
                <div className="lib-card-head">
                  <h3>{p.name}</h3>
                  <span className="pill blue">{p.video_count} videos</span>
                </div>
                <p>
                  The {p.video_count} videos ({minutes(p.total_seconds)} in all) a patient watches in order before their{' '}
                  {p.name.toLowerCase()}. <Link to={`/doctor/procedures/${encodeURIComponent(p.id)}`}>View videos</Link>
                </p>
                <div className="lib-card-foot">
                  <span><strong>{n}</strong> patient{n === 1 ? '' : 's'}</span>
                  <button className="invite-link" onClick={() => invite(p.id)} disabled={p.video_count === 0}>
                    Invite patient <span className="icon-button" aria-hidden="true"><InviteIcon /></span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {evergreen.length > 0 && (
        <section className="stack">
          <h2>Before you begin</h2>
          <p className="muted">Every patient can watch these before their procedure's videos. They're optional and aren't part of the certificate.</p>
          <div className="library-grid">
            {evergreen.map((v) => (
              <article key={v.id} className="lib-card">
                <Thumb src={`/api/doctor/${v.playlist}`} label={`Preview ${v.title}`} onClick={() => setPlaying(v)} />
                <div className="lib-card-head">
                  <h3>{v.title}</h3>
                  <span className="pill">{formatDuration(v.durationSeconds)}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
