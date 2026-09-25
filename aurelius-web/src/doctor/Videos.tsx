import { useEffect, useState } from 'react';
import { ApiError, formatDuration } from '../api';
import { PlainPlayer, type EvergreenVideo } from '../components/PlainPlayer';
import { Thumb } from '../components/Thumb';
import { InviteIcon } from '../components/icons';
import { useInvite, type PatientRow, type Procedure } from './library';
import { doctorApi, navigate } from './nav';
import { PatientsPanel } from './PatientsPanel';

interface ProcedureVideos {
  procedure: { id: string; name: string };
  videos: Array<{ id: string; title: string; order: number; durationSeconds: number; playlist: string }>;
}

// One card per video, from every procedure plus the "Before you begin" ones.
interface Card {
  key: string;
  group: string;           // procedure id, or EVERGREEN
  category: string;
  title: string;
  order: number;
  durationSeconds: number;
  src: string;             // preview playlist
  open: () => void;
}

const EVERGREEN = 'evergreen';

// The doctor's home: every video, filterable by procedure, with the
// Patients panel alongside. Clicking a video opens its procedure's page on
// that video (or plays a "Before you begin" video right here).
export function Videos() {
  const invite = useInvite();
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [sets, setSets] = useState<ProcedureVideos[]>([]);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [evergreen, setEvergreen] = useState<EvergreenVideo[]>([]);
  const [filter, setFilter] = useState('all');
  const [playing, setPlaying] = useState<EvergreenVideo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const [p, pts, e] = await Promise.all([
        doctorApi<Procedure[]>('/procedures'),
        doctorApi<PatientRow[]>('/patients'),
        doctorApi<{ videos: EvergreenVideo[] }>('/evergreen'),
      ]);
      const withVideos = p.filter((x) => x.video_count > 0);
      const all = await Promise.all(withVideos.map((x) => doctorApi<ProcedureVideos>(`/procedures/${encodeURIComponent(x.id)}/videos`)));
      setProcedures(p);
      setSets(all);
      setPatients(pts);
      setEvergreen(e.videos);
    })().catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the videos.'));
  }, []);

  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!procedures) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  if (playing) {
    return <PlainPlayer title={playing.title} src={`/api/doctor/${playing.playlist}`} backLabel="← All videos" onBack={() => setPlaying(null)} />;
  }

  const cards: Card[] = [
    ...sets.flatMap((s) =>
      s.videos.map((v) => ({
        key: v.id,
        group: s.procedure.id,
        category: s.procedure.name,
        title: v.title,
        order: v.order,
        durationSeconds: v.durationSeconds,
        src: `/api/doctor/${v.playlist}`,
        open: () => navigate(`/doctor/procedures/${encodeURIComponent(s.procedure.id)}?video=${encodeURIComponent(v.id)}`),
      }))
    ),
    ...evergreen.map((v) => ({
      key: v.id,
      group: EVERGREEN,
      category: 'Before you begin',
      title: v.title,
      order: v.order,
      durationSeconds: v.durationSeconds,
      src: `/api/doctor/${v.playlist}`,
      open: () => setPlaying(v),
    })),
  ];
  const shownCount = filter === 'all' ? cards.length : cards.filter((c) => c.group === filter).length;
  const groups = [
    ...sets.map((s) => ({ id: s.procedure.id, label: s.procedure.name, count: s.videos.length })),
    ...(evergreen.length ? [{ id: EVERGREEN, label: 'Before you begin', count: evergreen.length }] : []),
  ];
  const chips = [{ id: 'all', label: 'All', count: cards.length }, ...groups];
  const active = patients.filter((r) => !r.revoked_at).slice(0, 8);

  return (
    <div className="procedure-layout">
      <div className="stack-lg">
        <div className="chips" role="group" aria-label="Show videos for">
          {chips.map((c) => (
            <button key={c.id} className={`chip ${filter === c.id ? 'active' : ''}`} aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
              {c.label} ({c.count})
            </button>
          ))}
        </div>
        <div className="row">
          <h1 style={{ margin: 0 }}>{filter === 'all' ? 'All videos' : chips.find((c) => c.id === filter)?.label} ({shownCount})</h1>
          <button className="button" onClick={() => invite(filter !== 'all' && filter !== EVERGREEN ? filter : undefined)}>
            <InviteIcon /> Invite patient
          </button>
        </div>

        {cards.length === 0 && (
          <div className="card"><p>No videos yet. They're added with <code>npm run package-video</code>.</p></div>
        )}
        {groups
          .filter((g) => filter === 'all' || g.id === filter)
          .map((g) => {
            const groupCards = cards.filter((c) => c.group === g.id);
            if (groupCards.length === 0) return null;
            const isProcedure = g.id !== EVERGREEN;
            return (
              <section key={g.id} className="video-group">
                <div className="video-group-head">
                  <div>
                    <h2>{g.label}</h2>
                    <p className="muted">
                      {isProcedure
                        ? `One procedure: ${groupCards.length} videos, watched in order 1–${groupCards.length}. The certificate is issued once all ${groupCards.length} are complete.`
                        : 'Optional videos every patient can watch first. Not part of the certificate.'}
                    </p>
                  </div>
                  {isProcedure && (
                    <button className="invite-link" onClick={() => invite(g.id)}>
                      Invite patient to {g.label} <span className="icon-button" aria-hidden="true"><InviteIcon /></span>
                    </button>
                  )}
                </div>
                <div className="video-grid">
                  {groupCards.map((c) => (
                    <article key={c.key} className="vid-card">
                      <Thumb src={c.src} label={`View ${c.title}`} onClick={c.open} />
                      <div className="vid-card-body">
                        <span className="vid-category">{isProcedure ? `${c.category} · ${c.order} of ${groupCards.length}` : c.category}</span>
                        <h3>{c.title}</h3>
                        <div className="vid-card-foot">
                          <span className="muted">{formatDuration(c.durationSeconds)}</span>
                          <button className="link-button" onClick={c.open}>View</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
      </div>

      <PatientsPanel rows={active} seeAll />
    </div>
  );
}
