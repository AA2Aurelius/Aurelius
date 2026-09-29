import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, formatDateTime, formatDuration } from '../api';
import { Link, doctorApi, navigate, setFlash, useFlash } from './nav';
import { linkStatus } from './status';

interface Detail {
  id: string;
  patient_name: string;
  patient_email: string;
  procedure_name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  replaces_prescription_id: string | null;
  replaced_by: string | null;
  hours_left: number;
  videos: Array<{
    id: string;
    title: string;
    order_index: number;
    duration_seconds: number;
    started_at: string | null;
    completed_at: string | null;
    seek_attempts: number;
    pause_count: number;
    watched_ms: number;
    last_watched_at: string | null;
    checks_passed: number;
    checks_missed: number;
  }>;
  confirmed_at: string | null;
  last_activity_at: string | null;
  archived_at: string | null;
}

type Action = 'none' | 'resend' | 'cancel';

export function PatientDetail({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState<Action>('none');
  const [notice, setNotice] = useFlash();

  const load = useCallback(() => {
    doctorApi<Detail>(`/prescriptions/${encodeURIComponent(id)}`)
      .then(setD)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this patient.'));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <div className="card stack"><p className="error">{error}</p><Link to="/doctor/patients">← Patients</Link></div>;
  if (!d) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const done = d.videos.filter((v) => v.completed_at).length;
  const certified = d.videos.length > 0 && done === d.videos.length;
  const base = linkStatus({ ...d, certified, videos_done: done, videos_total: d.videos.length });
  // "Not started" only until the patient does something: opening the link
  // and confirming, then watching, show as progress.
  const anyWatched = d.videos.some((v) => (v.watched_ms ?? 0) > 0);
  const status = d.archived_at
    ? { ...base, label: certified ? 'Complete · archived' : 'Archived' }
    : base.label === 'Not started' && anyWatched
    ? { ...base, label: 'In progress' }
    : base.label === 'Not started' && d.confirmed_at
      ? { ...base, label: 'Opened the link' }
      : base;
  const totalMs = d.videos.reduce((n, v) => n + v.duration_seconds * 1000, 0);
  const watchedMs = d.videos.reduce((n, v) => n + Math.min(v.watched_ms ?? 0, v.duration_seconds * 1000), 0);
  const pctWatched = totalMs ? Math.round((100 * watchedMs) / totalMs) : 0;
  const canResend = !certified && !d.replaced_by;
  const canCancel = !certified && !d.revoked_at;

  return (
    <div className="stack-lg">
      <div className="stack">
        <Link to="/doctor/patients">← Patients</Link>
        <div className="row">
          <h1>{d.patient_name}</h1>
          <span className={`pill ${status.tone}`}>{status.label}</span>
        </div>
        <p className="muted">{d.procedure_name} · {d.patient_email}</p>
      </div>

      {notice && <div className="banner success"><p>{notice}</p></div>}

      {d.replaced_by && (
        <div className="banner">
          <p>
            This link was replaced by a new one.{' '}
            <Link to={`/doctor/patients/${encodeURIComponent(d.replaced_by)}`}>Open the new link's progress</Link>
          </p>
        </div>
      )}
      {d.replaces_prescription_id && (
        <p className="hint">
          This is a resent link.{' '}
          <Link to={`/doctor/patients/${encodeURIComponent(d.replaces_prescription_id)}`}>See the earlier link</Link>
        </p>
      )}

      {certified && (
        <div className="banner success with-action">
          <p><strong>All videos complete.</strong> The certificate is ready.</p>
          <Link to={`/doctor/patients/${encodeURIComponent(d.id)}/certificate`} className="button">View certificate</Link>
        </div>
      )}

      <section className="summary-tiles" aria-label="Summary">
        <div className="tile">
          <span className="tile-label">Videos watched</span>
          <strong className="tile-value">{done} of {d.videos.length}</strong>
          <div className={`bar ${certified ? 'done' : ''}`} aria-hidden="true"><span style={{ width: `${pctWatched}%` }} /></div>
          <span className="tile-sub">{pctWatched}% of the viewing time</span>
        </div>
        <div className="tile">
          <span className="tile-label">Identity confirmed</span>
          <strong className="tile-value">{d.confirmed_at ? '✓ Yes' : 'Not yet'}</strong>
          <span className="tile-sub">{d.confirmed_at ? formatDateTime(d.confirmed_at) : "They haven't opened the link and entered the emailed code yet."}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Last activity</span>
          <strong className="tile-value">{d.last_activity_at ? formatDateTime(d.last_activity_at) : '—'}</strong>
          <span className="tile-sub">{d.last_activity_at ? 'Last time a video was playing' : 'No viewing yet'}</span>
        </div>
        <div className="tile">
          <span className="tile-label">{d.hours_left > 0 ? 'Link works until' : 'Link expired'}</span>
          <strong className="tile-value">{formatDateTime(d.expires_at)}</strong>
          <span className="tile-sub">Sent {formatDateTime(d.created_at)}</span>
        </div>
      </section>

      <section className="card stack">
        <h2>Viewing, video by video</h2>
        <p className="muted" style={{ margin: 0 }}>
          Each video is released no faster than real time, so the bar shows how much the patient has actually watched. Skips are
          blocked, and "still watching?" checks confirm someone is there.
        </p>
        <ol className="view-list">
          {d.videos.map((v) => {
            const total = v.duration_seconds * 1000;
            const pct = total ? Math.round((100 * Math.min(v.watched_ms, total)) / total) : 0;
            return (
              <li key={v.id} className={v.completed_at ? 'done' : v.watched_ms > 0 ? 'partial' : ''}>
                <span className="view-num" aria-hidden="true">{v.completed_at ? '✓' : v.order_index}</span>
                <div className="view-body">
                  <div className="view-head">
                    <strong>{v.order_index}. {v.title}</strong>
                    <span className={`view-state ${v.completed_at ? 'done' : ''}`}>
                      {v.completed_at ? `✓ Complete · ${formatDateTime(v.completed_at)}` : v.watched_ms > 0 ? `In progress · ${pct}%` : 'Not started'}
                    </span>
                  </div>
                  <div className={`bar ${v.completed_at ? 'done' : ''}`} aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
                  <p className="view-facts">
                    Watched {formatDuration(Math.min(v.watched_ms, total) / 1000)} of {formatDuration(v.duration_seconds)}
                    {' · '}Checks passed: {v.checks_passed}{v.checks_missed ? ` (missed ${v.checks_missed})` : ''}
                    {' · '}Pauses: {v.pause_count}
                    {' · '}Skips blocked: {v.seek_attempts}
                    {v.started_at && !v.completed_at ? ` · Started ${formatDateTime(v.started_at)}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
        {d.revoked_at && (
          <p className="muted" style={{ margin: 0 }}>
            {d.revoked_reason === 'resent' ? 'Replaced' : d.revoked_reason === 'archived' ? 'Archived' : 'Cancelled'} {formatDateTime(d.revoked_at)}.
          </p>
        )}
      </section>

      {(canResend || canCancel) && action === 'none' && (
        <div className="controls">
          {canResend && <button className="button" onClick={() => { setNotice(''); setAction('resend'); }}>Send a new link</button>}
          {canCancel && <button className="button secondary danger-text" onClick={() => { setNotice(''); setAction('cancel'); }}>Cancel link</button>}
        </div>
      )}
      {action === 'resend' && (
        <ResendForm
          d={d}
          onCancel={() => setAction('none')}
          onSent={(newId, emailSent, to) => {
            setFlash(emailSent ? `A new link was emailed to ${to}.` : `The new link was created, but the email to ${to} failed to send. Try sending again.`);
            navigate(`/doctor/patients/${encodeURIComponent(newId)}`);
          }}
        />
      )}
      {action === 'cancel' && (
        <CancelForm id={d.id} onClose={() => setAction('none')} onCancelled={() => { setAction('none'); setNotice('The link was cancelled.'); load(); }} />
      )}
    </div>
  );
}

function ResendForm({ d, onCancel, onSent }: { d: Detail; onCancel: () => void; onSent: (newId: string, emailSent: boolean, to: string) => void }) {
  const [email, setEmail] = useState(d.patient_email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = d.videos.some((v) => v.started_at);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await doctorApi<{ prescriptionId: string; emailSent: boolean }>(
        `/prescriptions/${encodeURIComponent(d.id)}/resend`,
        { json: { patient_email: email.trim() } }
      );
      onSent(r.prescriptionId, r.emailSent, email.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a new link.');
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Send a new link</h2>
      <p>
        {d.patient_name} gets a new link that works for 48 hours. The current link stops working
        {started ? ', and they start the videos again from the beginning' : ''}.
      </p>
      <label htmlFor="remail">Send to</label>
      <input id="remail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <p className="hint">Change this if the email was mistyped.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="controls">
        <button className="button" type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send new link'}</button>
        <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Back</button>
      </div>
    </form>
  );
}

function CancelForm({ id, onClose, onCancelled }: { id: string; onClose: () => void; onCancelled: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await doctorApi(`/prescriptions/${encodeURIComponent(id)}/cancel`, { json: reason.trim() ? { reason: reason.trim() } : {} });
      onCancelled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the link.');
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Cancel this link?</h2>
      <p>The patient won't be able to open it any more. You can send them a new link later.</p>
      <label htmlFor="reason">Reason (optional, kept in the record)</label>
      <textarea id="reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="controls">
        <button className="button danger" type="submit" disabled={busy}>{busy ? 'Cancelling…' : 'Cancel link'}</button>
        <button className="button secondary" type="button" onClick={onClose} disabled={busy}>Keep link</button>
      </div>
    </form>
  );
}
