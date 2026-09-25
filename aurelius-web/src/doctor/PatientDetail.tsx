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
  }>;
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

  if (error) return <div className="card stack"><p className="error">{error}</p><Link to="/doctor">← Patients</Link></div>;
  if (!d) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const done = d.videos.filter((v) => v.completed_at).length;
  const certified = d.videos.length > 0 && done === d.videos.length;
  const status = linkStatus({ ...d, certified, videos_done: done, videos_total: d.videos.length });
  const canResend = !certified && !d.replaced_by;
  const canCancel = !certified && !d.revoked_at;

  return (
    <div className="stack-lg">
      <div className="stack">
        <Link to="/doctor">← Patients</Link>
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

      <section className="card stack">
        <h2>Progress <span className="muted">({done} of {d.videos.length} complete)</span></h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>#</th><th>Video</th><th>Length</th><th>Started</th><th>Completed</th><th>Pauses</th><th>Skip attempts</th></tr>
            </thead>
            <tbody>
              {d.videos.map((v) => (
                <tr key={v.id}>
                  <td>{v.order_index}</td>
                  <td>{v.title}</td>
                  <td>{formatDuration(v.duration_seconds)}</td>
                  <td>{v.started_at ? formatDateTime(v.started_at) : '—'}</td>
                  <td>{v.completed_at ? `✓ ${formatDateTime(v.completed_at)}` : '—'}</td>
                  <td>{v.pause_count}</td>
                  <td>{v.seek_attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="facts">
          <dt>Sent</dt>
          <dd>{formatDateTime(d.created_at)}</dd>
          <dt>{d.hours_left > 0 ? 'Link works until' : 'Link expired'}</dt>
          <dd>{formatDateTime(d.expires_at)}</dd>
          {d.revoked_at && (
            <>
              <dt>{d.revoked_reason === 'resent' ? 'Replaced' : 'Cancelled'}</dt>
              <dd>{formatDateTime(d.revoked_at)}</dd>
            </>
          )}
        </dl>
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
