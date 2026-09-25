import { useEffect, useState } from 'react';
import { ApiError, formatDuration } from '../api';
import { VideoFrame } from '../components/PlainPlayer';
import type { PatientRow } from './library';
import { Link, doctorApi } from './nav';
import { PatientsPanel } from './PatientsPanel';

interface ProcedureVideos {
  procedure: { id: string; name: string };
  videos: Array<{ id: string; title: string; order: number; durationSeconds: number; playlist: string; poster: string | null }>;
}

// One procedure: preview its videos, see them in order, and see which of
// this doctor's patients have been sent it (cancelled links left out), with
// hours left on their link.
export function ProcedurePage({ id }: { id: string }) {
  const [data, setData] = useState<ProcedureVideos | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [current, setCurrent] = useState(0);
  const wanted = new URLSearchParams(location.search).get('video');
  const [error, setError] = useState('');

  useEffect(() => {
    doctorApi<ProcedureVideos>(`/procedures/${encodeURIComponent(id)}/videos`)
      .then((d) => {
        setData(d);
        const i = d.videos.findIndex((v) => v.id === wanted);
        if (i > 0) setCurrent(i);
      })
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
            <span className="cat-pill">{data.procedure.name}</span>
          </div>
          {video ? <VideoFrame key={video.id} src={`/api/doctor/${video.playlist}`} poster={video.poster && `/api/doctor/${video.poster}`} /> : <p className="muted">This procedure has no videos yet.</p>}
          <section className="card stack">
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

        <PatientsPanel rows={patients} procedureId={id} />
      </div>
    </div>
  );
}
