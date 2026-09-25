import { useEffect, useState } from 'react';
import { ApiError, formatDuration } from '../api';
import { VideoFrame } from '../components/PlainPlayer';
import { InviteIcon } from '../components/icons';
import { useInvite, type PatientRow } from './library';
import { Link, doctorApi } from './nav';
import { linkStatus } from './status';

interface ProcedureVideos {
  procedure: { id: string; name: string };
  videos: Array<{ id: string; title: string; order: number; durationSeconds: number; playlist: string }>;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

// One procedure: preview its videos, see them in order, and see which of
// this doctor's patients have been sent it (cancelled links left out), with
// hours left on their link.
export function ProcedurePage({ id }: { id: string }) {
  const invite = useInvite();
  const [data, setData] = useState<ProcedureVideos | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    doctorApi<ProcedureVideos>(`/procedures/${encodeURIComponent(id)}/videos`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this procedure.'));
    doctorApi<PatientRow[]>('/patients')
      .then((rows) => setPatients(rows.filter((r) => r.procedure_id === id && !r.revoked_at)))
      .catch(() => {});
  }, [id]);

  if (error) return <div className="card stack"><p className="error">{error}</p><Link to="/doctor">← All videos</Link></div>;
  if (!data) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const video = data.videos[current];
  const total = data.videos.reduce((s, v) => s + v.durationSeconds, 0);

  return (
    <div className="stack">
      <Link to="/doctor">← All videos</Link>
      <div className="procedure-layout">
        <div className="stack-lg">
          <div className="row">
            <h1 style={{ margin: 0 }}>{video ? video.title : data.procedure.name}</h1>
            <span className="pill blue">{data.procedure.name}</span>
          </div>
          {video ? <VideoFrame key={video.id} src={`/api/doctor/${video.playlist}`} /> : <p className="muted">This procedure has no videos yet.</p>}
          <section className="stack">
            <h2>Videos in this set <span className="muted">({data.videos.length} · {formatDuration(total)})</span></h2>
            <p className="muted">
              Patients watch these in order. Each unlocks after the previous one, and skipping ahead is blocked. This preview
              has no effect on any patient's progress.
            </p>
            <ol className="takeaways">
              {data.videos.map((v, i) => (
                <li key={v.id} className={i === current ? 'now' : ''}>
                  <button onClick={() => setCurrent(i)} aria-current={i === current ? 'true' : undefined}>
                    {v.title} <span className="muted">· {formatDuration(v.durationSeconds)}{i === current ? ' · playing' : ''}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="side-panel">
          <h2>Patients <span className="muted" style={{ fontSize: '0.8rem' }}>{patients.length}</span></h2>
          {patients.length === 0 ? (
            <p className="muted">No patients have been sent this procedure yet.</p>
          ) : (
            <ul className="person-list">
              {patients.map((r) => {
                const status = linkStatus({ ...r, certified: !!r.certified_at });
                const stat = r.certified_at
                  ? { text: '✓', cls: 'done', title: 'Complete' }
                  : r.revoked_at
                    ? { text: '—', cls: '', title: status.label }
                    : r.hours_left <= 0
                      ? { text: 'Expired', cls: 'late', title: 'Link expired' }
                      : { text: `${Math.floor(r.hours_left)}h`, cls: r.hours_left < 12 ? 'late' : '', title: `${Math.floor(r.hours_left)} hours left` };
                return (
                  <li key={r.id}>
                    <Link to={`/doctor/patients/${encodeURIComponent(r.id)}`}>
                      <span className="avatar" aria-hidden="true">{initials(r.patient_name)}</span>
                      <span className="person-meta">
                        <strong>{r.patient_name}</strong>
                        <span>{r.videos_done} of {r.videos_total} videos · {status.label}</span>
                      </span>
                      <span className={`person-stat ${stat.cls}`} title={stat.title}>{stat.text}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <button className="invite-link" onClick={() => invite(id)}>
            Invite patient <span className="icon-button" aria-hidden="true"><InviteIcon /></span>
          </button>
        </aside>
      </div>
    </div>
  );
}
