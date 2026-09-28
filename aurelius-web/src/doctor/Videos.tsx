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
  videos: Array<{ id: string; title: string; order: number; durationSeconds: number; playlist: string; poster: string | null }>;
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
  poster: string | null;    // still frame
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
  const [sort, setSort] = useState('order');
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
    return <PlainPlayer title={playing.title} src={`/api/doctor/${playing.playlist}`} poster={playing.poster && `/api/doctor/${playing.poster}`} backLabel="← All videos" onBack={() => setPlaying(null)} />;
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
        poster: v.poster ? `/api/doctor/${v.poster}` : null,
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
      poster: v.poster ? `/api/doctor/${v.poster}` : null,
      open: () => setPlaying(v),
    })),
  ];
  const groups = [
    ...sets.map((s) => ({ id: s.procedure.id, label: s.procedure.name, count: s.videos.length })),
    ...(evergreen.length ? [{ id: EVERGREEN, label: 'Before you begin', count: evergreen.length }] : []),
  ];
  const countIn = (group: string) => cards.filter((c) => c.group === group).length;
  // Patients per procedure (current links), as on the wireframe's cards.
  const patientsIn = (group: string) => patients.filter((r) => r.procedure_id === group && !r.revoked_at).length;
  const shown = cards.filter((c) => filter === 'all' || c.group === filter);
  const flat = sort !== 'order';
  if (sort === 'title') shown.sort((x, y) => x.title.localeCompare(y.title));
  if (sort === 'short') shown.sort((x, y) => x.durationSeconds - y.durationSeconds);
  if (sort === 'long') shown.sort((x, y) => y.durationSeconds - x.durationSeconds);
  const active = patients.filter((r) => !r.revoked_at).slice(0, 8);

  const card = (c: Card) => {
    const isProcedure = c.group !== EVERGREEN;
    const n = patientsIn(c.group);
    return (
      <article key={c.key} className="vid-card">
        <Thumb src={c.src} poster={c.poster} label={`View ${c.title}`} onClick={c.open} />
        <div className="vid-card-body">
          <div className="vid-card-title">
            <h3>{c.title}</h3>
            <span className="cat-pill">{c.category}</span>
          </div>
          <p className="vid-desc">
            {isProcedure
              ? `Video ${c.order} of ${countIn(c.group)} in the ${c.category} set · ${formatDuration(c.durationSeconds)}.`
              : `Optional video every patient can watch first · ${formatDuration(c.durationSeconds)}.`}{' '}
            <button className="link-button inline" onClick={c.open}>View details</button>
          </p>
          <div className="vid-card-foot">
            {isProcedure ? (
              <>
                <span><strong className="count">{n}</strong> {n === 1 ? 'patient' : 'patients'}</span>
                <button className="invite-link" onClick={() => invite(c.group)}>
                  Invite patient <span className="icon-button" aria-hidden="true"><InviteIcon /></span>
                </button>
              </>
            ) : (
              <span className="muted">Shown to every patient</span>
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="procedure-layout">
      <div className="stack-lg">
        <div className="list-head">
          <h1>{filter === 'all' ? 'All Videos' : groups.find((g) => g.id === filter)?.label} ({shown.length})</h1>
          <div className="list-tools">
            <label className="select-wrap">
              <span className="sr-only">Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
                <option value="order">Sort by: procedure order</option>
                <option value="title">Sort by: title A–Z</option>
                <option value="short">Sort by: shortest first</option>
                <option value="long">Sort by: longest first</option>
              </select>
            </label>
            <label className="select-wrap">
              <span className="sr-only">Category</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Category">
                <option value="all">Category: all ({cards.length})</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.label} ({g.count})</option>)}
              </select>
            </label>
            <button className="button" onClick={() => invite(filter !== 'all' && filter !== EVERGREEN ? filter : undefined)}>
              <InviteIcon /> Invite patient
            </button>
          </div>
        </div>

        {cards.length === 0 && (
          <div className="card"><p>No videos yet. They're added with <code>npm run package-video</code>.</p></div>
        )}
        {flat ? (
          <div className="video-grid">{shown.map(card)}</div>
        ) : (
          groups
            .filter((g) => filter === 'all' || g.id === filter)
            .map((g) => {
              const groupCards = shown.filter((c) => c.group === g.id);
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
                  <div className="video-grid">{groupCards.map(card)}</div>
                </section>
              );
            })
        )}
      </div>

      <PatientsPanel rows={active} seeAll />
    </div>
  );
}
