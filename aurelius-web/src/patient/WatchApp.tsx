import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { CertificateView, type CertificateResponse } from '../components/CertificateView';
import { PlainPlayer, type EvergreenVideo } from '../components/PlainPlayer';
import { PacedPlayer } from './PacedPlayer';
import { Acknowledge, Questions } from './Questions';
import { Portal, type PortalData, type PortalVideo } from './Portal';
import { VerifyIdentity } from './VerifyIdentity';

// Everything a patient sees at /watch/{token}.

type Unverified = { verified: false; codeDestination: string; hoursLeft: number; certified: boolean };
type View =
  | { kind: 'portal' }
  | { kind: 'video'; video: PortalVideo }
  | { kind: 'evergreen'; video: EvergreenVideo }
  | { kind: 'questions'; video: PortalVideo }
  | { kind: 'acknowledge' }
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
      return d;
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
  // After a video or its questions: reload, then go to whatever is next:
  // the questions about the video just watched, the next video, the closing
  // confirmation, or the certificate.
  const advance = async () => {
    const d = await load();
    if (!d?.verified) return setView({ kind: 'portal' });
    if (d.certified) return setView({ kind: 'certificate' });
    const next = d.videos.find((v) => v.unlocked && !v.complete);
    if (next) return setView(next.questions_pending ? { kind: 'questions', video: next } : { kind: 'video', video: next });
    setView(d.videos.every((v) => v.complete) && !d.acknowledged ? { kind: 'acknowledge' } : { kind: 'portal' });
  };

  switch (view.kind) {
    case 'evergreen':
      return <PlainPlayer title={view.video.title} src={`${base}/${view.video.playlist}`} poster={view.video.poster && `${base}/${view.video.poster}`} captions={view.video.captions && `${base}/${view.video.captions}`} backLabel="← Your videos" onBack={() => setView({ kind: 'portal' })} />;
    case 'questions':
      return (
        <Questions
          key={view.video.id}
          token={token}
          video={view.video}
          total={data.videos.length}
          onDone={advance}
          onRewatch={() => setView({ kind: 'video', video: view.video })}
          onBack={backToPortal}
        />
      );
    case 'acknowledge':
      return <Acknowledge token={token} statement={data.acknowledgment} onDone={advance} onBack={backToPortal} />;
    case 'certificate':
      return <CertificateView load={() => api<CertificateResponse>(`${base}/certificate`)} backLabel="← Your videos" onBack={() => setView({ kind: 'portal' })} />;
    default: {
      // The video being watched plays in the main area; the set stays listed
      // alongside it.
      const playing = view.kind === 'video' ? view.video : undefined;
      return (
        <Portal
          data={data}
          evergreen={evergreen}
          evergreenBase={base}
          playingId={playing?.id}
          player={playing && (
            <PacedPlayer
              key={playing.id}
              token={token}
              video={playing}
              total={data.videos.length}
              nextTitle={data.videos.find((v) => v.order_index > playing.order_index)?.title}
              onComplete={load}
              onDone={backToPortal}
              onNext={advance}
              onCertificate={advance}
              onBack={backToPortal}
            />
          )}
          onPlay={(video) => setView({ kind: 'video', video })}
          onQuestions={(video) => setView({ kind: 'questions', video })}
          onAcknowledge={() => setView({ kind: 'acknowledge' })}
          onPlayEvergreen={(video) => setView({ kind: 'evergreen', video })}
          onCertificate={() => setView({ kind: 'certificate' })}
        />
      );
    }
  }
}
