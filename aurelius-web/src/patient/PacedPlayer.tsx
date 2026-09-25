import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, formatDuration } from '../api';
import { attachHls } from '../video';

// The server-paced player for a prescribed video. The server decides
// everything that matters (how much of the video is released, attention
// checks, completion); this component plays what it's given and reports
// what the player is doing every few seconds:
//
//  * a heartbeat every `heartbeatIntervalMs` with the position, whether it's
//    playing and whether the page is visible;
//  * the "Are you still watching?" prompt when the server issues one, with
//    playback paused until it's answered;
//  * playback pauses when the page goes into the background;
//  * no scrubbing forward: the only controls are play/pause and back 10 s,
//    and any forward jump (keyboard, native controls) is undone and reported.

export interface PrescribedVideo {
  id: string;
  title: string;
  order_index: number;
  duration_seconds: number;
}

interface CheckInfo { id: string; prompt: string; expiresAt: string }

interface PlaybackState {
  playbackId: string;
  totalMs: number;
  allowedMs: number;
  releasedThrough: number;
  nextSeq: number;
  completed: boolean;
  attentionCheck: CheckInfo | null;
  heartbeatIntervalMs?: number;
  playlist?: string;
  resumed?: boolean;
}

type Phase = 'starting' | 'ready' | 'complete' | 'error';

// A forward jump bigger than this (seconds) past the furthest point reached
// is treated as a skip attempt.
const SKIP_TOLERANCE_S = 2;

export function PacedPlayer({ token, video, onDone, onBack }: {
  token: string;
  video: PrescribedVideo;
  onDone: () => void;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [position, setPosition] = useState(0);
  const [check, setCheck] = useState<CheckInfo | null>(null);
  const [checkNote, setCheckNote] = useState('');
  const [awayPaused, setAwayPaused] = useState(false);
  const [connectionTrouble, setConnectionTrouble] = useState(false);
  const [skipNotice, setSkipNotice] = useState(false);
  const [skipsBlocked, setSkipsBlocked] = useState(0);
  const [blockedFlash, setBlockedFlash] = useState(false);

  const base = `/api/watch/${encodeURIComponent(token)}`;
  const stateRef = useRef<PlaybackState | null>(null);
  const seqRef = useRef(1);
  const inFlight = useRef(false);
  const maxReached = useRef(0);
  const lastSkipReport = useRef(0);
  const checkRef = useRef<CheckInfo | null>(null);
  checkRef.current = check;

  const applyState = useCallback((st: PlaybackState) => {
    stateRef.current = { ...stateRef.current, ...st };
    if (st.completed) {
      setPhase('complete');
      videoRef.current?.pause();
      return;
    }
    if (st.attentionCheck && st.attentionCheck.id !== checkRef.current?.id) {
      videoRef.current?.pause();
      setCheck(st.attentionCheck);
    } else if (!st.attentionCheck && checkRef.current) {
      setCheck(null);
    }
  }, []);

  // ---- start (or resume) the playback, then attach the stream
  useEffect(() => {
    let detach = () => {};
    let cancelled = false;
    (async () => {
      try {
        const st = await api<PlaybackState>(`${base}/video/${video.id}/playback`, { method: 'POST' });
        if (cancelled) return;
        stateRef.current = st;
        seqRef.current = st.nextSeq;
        if (st.completed) {
          setPhase('complete');
          return;
        }
        // Resume where the server says the patient had got to.
        const resumeAt = st.resumed ? Math.max(0, st.allowedMs / 1000 - 1) : 0;
        maxReached.current = resumeAt;
        setPosition(resumeAt);
        detach = attachHls(videoRef.current!, `${base}/${st.playlist}`, {
          startSeconds: resumeAt,
          onFatal: (message) => {
            setError(message);
            setPhase('error');
          },
        });
        applyState(st);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong starting the video.');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      detach();
    };
  }, [base, video.id, applyState]);

  // ---- heartbeats
  const sendHeartbeat = useCallback(async () => {
    const st = stateRef.current;
    const v = videoRef.current;
    if (!st || !v || inFlight.current || st.completed) return;
    inFlight.current = true;
    // "Playing" means the patient means it to be playing (so a moment of
    // buffering doesn't count against them). Once the video has ended, keep
    // saying so until the server confirms completion.
    const isPlaying = (!v.paused && !v.ended) || v.ended;
    try {
      const next = await api<PlaybackState>(`${base}/playback/${st.playbackId}/heartbeat`, {
        json: {
          seq: seqRef.current,
          position_ms: Math.max(0, Math.floor(v.currentTime * 1000)),
          playing: isPlaying && !checkRef.current,
          visible: document.visibilityState === 'visible',
          rate: v.playbackRate || 1,
        },
      });
      seqRef.current += 1;
      setConnectionTrouble(false);
      applyState(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.body?.expectedSeq === 'number') {
        seqRef.current = err.body.expectedSeq;
      } else if (err instanceof ApiError && (err.status === 401 || err.status === 410)) {
        v.pause();
        setError(err.status === 401
          ? 'Your session has ended. Reload the page and verify again to continue.'
          : 'This link has expired.');
        setPhase('error');
      } else {
        setConnectionTrouble(true);
      }
    } finally {
      inFlight.current = false;
    }
  }, [base, applyState]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const every = stateRef.current?.heartbeatIntervalMs ?? 5000;
    const id = setInterval(sendHeartbeat, every);
    return () => clearInterval(id);
  }, [phase, sendHeartbeat]);

  // ---- player events
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      setPlaying(true);
      setAwayPaused(false); // however playback resumed, the "away" prompt is done
    };
    const onPause = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onRate = () => {
      if (v.playbackRate !== 1) v.playbackRate = 1;
    };
    const onTime = () => {
      setPosition(v.currentTime);
      if (!v.seeking && v.currentTime > maxReached.current && v.currentTime <= maxReached.current + SKIP_TOLERANCE_S) {
        maxReached.current = v.currentTime;
      }
    };
    const onSeeking = () => {
      if (v.currentTime <= maxReached.current + SKIP_TOLERANCE_S) return;
      const attempted = v.currentTime;
      v.currentTime = maxReached.current;
      setSkipNotice(true);
      setSkipsBlocked((n) => n + 1);
      setBlockedFlash(true);
      const now = Date.now();
      if (now - lastSkipReport.current > 3000) {
        lastSkipReport.current = now;
        api(`${base}/video/${video.id}/seek-attempt`, {
          json: { from: Math.round(maxReached.current * 1000), to: Math.round(attempted * 1000) },
        }).catch(() => {});
      }
    };
    const onEnded = () => {
      setPlaying(false);
      sendHeartbeat();
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeking', onSeeking);
      v.removeEventListener('ended', onEnded);
    };
  }, [base, video.id, sendHeartbeat]);

  // ---- pause when the page goes into the background
  useEffect(() => {
    const onVisibility = () => {
      const v = videoRef.current;
      if (document.visibilityState === 'hidden' && v && !v.paused) {
        v.pause();
        setAwayPaused(true);
      }
      // Tell the server promptly either way.
      sendHeartbeat();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sendHeartbeat]);

  useEffect(() => {
    if (!skipNotice) return;
    const id = setTimeout(() => setSkipNotice(false), 4000);
    return () => clearTimeout(id);
  }, [skipNotice]);

  const play = () => {
    const v = videoRef.current;
    if (!v || checkRef.current) return;
    setAwayPaused(false);
    v.play().catch(() => {});
    // Report the change now rather than at the next tick.
    setTimeout(sendHeartbeat, 300);
  };
  const pause = () => {
    videoRef.current?.pause();
    setTimeout(sendHeartbeat, 300);
  };
  const back10 = () => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, v.currentTime - 10);
  };
  const fullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };
  const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;

  const answerCheck = async () => {
    const st = stateRef.current;
    const c = checkRef.current;
    if (!st || !c) return;
    try {
      const next = await api<PlaybackState>(`${base}/playback/${st.playbackId}/attention`, { json: { checkId: c.id } });
      setCheck(null);
      setCheckNote('');
      applyState(next);
      videoRef.current?.play().catch(() => {});
      setTimeout(sendHeartbeat, 300);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.attentionCheck) {
        setCheckNote('That took longer than 60 seconds, so it was recorded as missed. Please confirm again to continue.');
        setCheck(err.body.attentionCheck);
      } else if (err instanceof ApiError) {
        setCheckNote(err.message);
      }
    }
  };

  const totalS = video.duration_seconds || (stateRef.current ? stateRef.current.totalMs / 1000 : 0);
  const pct = totalS > 0 ? Math.min(100, (position / totalS) * 100) : 0;

  return (
    <div className="player-page">
      <button className="link-button" onClick={onBack}>✕ Close video</button>
      <h1 className="player-title">
        <span className="muted">Video {video.order_index}.</span> {video.title}
      </h1>

      <div className="player-shell" ref={shellRef}>
        <video ref={videoRef} playsInline preload="auto" className="player-video" onClick={() => (playing ? pause() : play())} />

        {phase === 'starting' && <div className="overlay"><div className="spinner" aria-label="Loading" /></div>}
        {phase === 'ready' && !playing && !check && !awayPaused && (
          <button className="overlay overlay-button" onClick={play} aria-label="Play">
            <span className="big-play">▶</span>
          </button>
        )}
        {phase === 'ready' && playing && buffering && <div className="overlay passive"><div className="spinner" aria-label="Loading" /></div>}
        {awayPaused && !check && phase !== 'complete' && (
          <div className="overlay modal">
            <div className="overlay-card">
              <p>Paused while you were away.</p>
              <button className="button" onClick={play}>Continue watching</button>
            </div>
          </div>
        )}
        {check && (
          <div className="overlay modal" role="dialog" aria-modal="true" aria-labelledby="check-title">
            <div className="overlay-card">
              <p id="check-title" className="check-title">{check.prompt}</p>
              {checkNote && <p className="note">{checkNote}</p>}
              <Countdown until={check.expiresAt} />
              <button className="button" onClick={answerCheck} autoFocus>I'm still watching</button>
            </div>
          </div>
        )}
        {phase === 'complete' && (
          <div className="overlay modal">
            <div className="overlay-card">
              <p className="done-mark" aria-hidden="true">✓</p>
              <p><strong>Video complete.</strong></p>
              <button className="button" onClick={onDone}>Continue</button>
            </div>
          </div>
        )}
      </div>

      <div className="progress-meta">
        <span className="time">{formatDuration(position)} / {formatDuration(totalS)}</span>
        <span className="lock-label">🔒 Locked — no skipping</span>
      </div>
      <div
        className={`progress ${blockedFlash ? 'blocked' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Progress"
        onAnimationEnd={() => setBlockedFlash(false)}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <span className="progress-handle" style={{ left: `${pct}%` }} aria-hidden="true" />
      </div>
      <div className="controls">
        <button className="button" onClick={() => (playing ? pause() : play())} disabled={phase !== 'ready' || !!check}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="button secondary" onClick={back10} disabled={phase !== 'ready'}>Back 10 s</button>
        {canFullscreen && <button className="button secondary" onClick={fullscreen}>Full screen</button>}
      </div>

      {skipNotice && (
        <div className="stack">
          <p className="note">Skipping ahead isn't available. The video continues from where you were.</p>
          <span className="skips-blocked">Skips blocked: {skipsBlocked}</span>
        </div>
      )}
      {connectionTrouble && <p className="note">Having trouble reaching Aurelius. Retrying…</p>}
      {phase === 'error' && <p className="error">{error}</p>}
      <p className="hint">
        Watch the whole video to continue. It pauses if you switch away, and you'll be asked now and then to confirm you're still watching.
      </p>
    </div>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return <p className="muted">{left > 0 ? `${left} seconds to respond` : 'Time is up. Please confirm to continue.'}</p>;
}
