import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, formatDuration } from '../api';
import { CertificateView, type CertificateResponse } from '../components/CertificateView';
import { PlainPlayer, type EvergreenVideo } from '../components/PlainPlayer';
import { PacedPlayer } from './PacedPlayer';
import { Portal, type PortalData, type PortalVideo } from './Portal';
import { VerifyIdentity } from './VerifyIdentity';

// Everything a patient sees at /watch/{token}.

type Unverified = { verified: false; codeDestination: string; hoursLeft: number; certified: boolean };
type View =
  | { kind: 'portal' }
  | { kind: 'video'; video: PortalVideo }
  | { kind: 'evergreen'; video: EvergreenVideo }
  | { kind: 'certificate' };

export function WatchApp({ token }: { token: string }) {
  const [data, setData] = useState<PortalData | Unverified | null>(null);
  const [evergreen, setEvergreen] = useState<EvergreenVideo[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>({ kind: 'portal' });
  const base = `/api/watch/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    try {
      const d = await api<PortalData | Unverified>(base);
      setData(d);
      setError('');
      if (d.verified) {
        api<{ videos: EvergreenVideo[] }>(`${base}/evergreen`).then((r) => setEvergreen(r.videos)).catch(() => {});
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 410
          ? 'This link is no longer valid. It may have expired or been replaced. Please contact your doctor for a new link.'
          : err instanceof ApiError ? err.message : 'Something went wrong.'
      );
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  if (error) return <div className="card"><h1>Link unavailable</h1><p>{error}</p></div>;
  if (!data) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  if (!data.verified) return <VerifyIdentity token={token} destination={data.codeDestination} onVerified={load} />;

  const backToPortal = () => {
    setView({ kind: 'portal' });
    load();
  };

  switch (view.kind) {
    case 'video':
      return (
        <div className="stack-lg">
          <PacedPlayer key={view.video.id} token={token} video={view.video} onDone={backToPortal} onBack={backToPortal} />
          <section className="card">
            <h2>{data.procedureName}: your videos</h2>
            <ol className="takeaways">
              {data.videos.map((v) => (
                <li key={v.id} className={v.id === view.video.id ? 'now' : v.complete ? 'done' : ''}>
                  <span>
                    {v.title} <span className="muted">· {formatDuration(v.duration_seconds)}{v.complete ? ' · ✓ complete' : v.id === view.video.id ? ' · watching now' : ''}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      );
    case 'evergreen':
      return <PlainPlayer title={view.video.title} src={`${base}/${view.video.playlist}`} backLabel="← All videos" onBack={() => setView({ kind: 'portal' })} />;
    case 'certificate':
      return <CertificateView load={() => api<CertificateResponse>(`${base}/certificate`)} backLabel="← All videos" onBack={() => setView({ kind: 'portal' })} />;
    default:
      return (
        <Portal
          data={data}
          evergreen={evergreen}
          evergreenBase={base}
          onPlay={(video) => setView({ kind: 'video', video })}
          onPlayEvergreen={(video) => setView({ kind: 'evergreen', video })}
          onCertificate={() => setView({ kind: 'certificate' })}
        />
      );
  }
}
