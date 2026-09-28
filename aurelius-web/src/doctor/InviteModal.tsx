import { FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, formatDateTime } from '../api';
import { Thumb } from '../components/Thumb';
import { minutes, procedurePoster, procedureThumb, type PatientRow, type Procedure } from './library';
import { Link, doctorApi } from './nav';

interface Sent { prescriptionId: string; watchUrl: string; expiresAt: string; emailSent: boolean; patientName: string; patientEmail: string }

// The Invite pop-up: patient name and email, and the procedure whose videos
// they should watch, picked from a list with thumbnails.
export function InviteModal({ initialProcedureId, onClose, onSent }: { initialProcedureId?: string; onClose: () => void; onSent: () => void }) {
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [thisMonth, setThisMonth] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [procedureId, setProcedureId] = useState(initialProcedureId ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Sent | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    doctorApi<Procedure[]>('/procedures')
      .then((list) => setProcedures(list.filter((p) => p.video_count > 0)))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load procedures.'));
    doctorApi<PatientRow[]>('/patients')
      .then((rows) => {
        const now = new Date();
        setThisMonth(rows.filter((r) => { const d = new Date(r.created_at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).length);
      })
      .catch(() => {});
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await doctorApi<Omit<Sent, 'patientName' | 'patientEmail'>>('/prescribe', {
        json: { patient_name: name.trim(), patient_email: email.trim(), procedure_id: procedureId },
      });
      setSent({ ...r, patientName: name.trim(), patientEmail: email.trim() });
      setThisMonth((n) => (n ?? 0) + 1);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setSent(null);
    setName('');
    setEmail('');
    setTimeout(() => firstField.current?.focus());
  };

  const chosen = procedures?.find((p) => p.id === procedureId);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="modal-head">
          <h2 id="invite-title">Invite</h2>
          {thisMonth !== null && (
            <div className="count-badge"><strong>{thisMonth}</strong><span>invites this month</span></div>
          )}
        </div>

        {sent ? (
          <SentView sent={sent} onAgain={again} onClose={onClose} />
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="float-field">
              <label htmlFor="pname">Patient's full name</label>
              <input id="pname" ref={firstField} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
            </div>
            <div className="float-field">
              <label htmlFor="pemail">Patient email</label>
              <input id="pemail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
            </div>
            <div className="float-field">
              <label id="proc-label">Videos</label>
              <button type="button" className="picker-button" aria-haspopup="listbox" aria-expanded={pickerOpen} aria-labelledby="proc-label" onClick={() => setPickerOpen((o) => !o)}>
                {chosen ? <strong>{chosen.name}</strong> : <span className="muted">Choose a procedure</span>}
                <span aria-hidden="true">{pickerOpen ? '▴' : '▾'}</span>
              </button>
              {pickerOpen && (
                <ul className="picker-list" role="listbox" aria-labelledby="proc-label">
                  {procedures === null && <li className="muted" style={{ padding: 8 }}>Loading…</li>}
                  {procedures?.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={p.id === procedureId}
                        className="picker-option"
                        onClick={() => { setProcedureId(p.id); setPickerOpen(false); }}
                      >
                        <Thumb src={procedureThumb(p)} poster={procedurePoster(p)} small />
                        <span className="opt-meta">
                          <span className="cat-pill">{p.video_count} videos · {minutes(p.total_seconds)}</span>
                          <strong>{p.name}</strong>
                        </span>
                        <span className={`plus-circle ${p.id === procedureId ? 'on' : ''}`} aria-hidden="true">{p.id === procedureId ? '✓' : '+'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="hint" style={{ marginTop: 4 }}>The patient gets an email with a link that works for 48 hours. The sign-in codes go to this address too.</p>

            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy || !name.trim() || !email.trim() || !procedureId} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send invite'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function SentView({ sent, onAgain, onClose }: { sent: Sent; onAgain: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sent.watchUrl);
      setCopied(true);
    } catch {}
  };
  return (
    <div className="stack">
      {sent.emailSent ? (
        <div className="banner success">
          <p><strong>Sent.</strong> {sent.patientName} will get an email at {sent.patientEmail} with their link.</p>
        </div>
      ) : (
        <div className="banner danger">
          <p>
            <strong>The invite was created, but the email to {sent.patientEmail} failed to send.</strong> Give the patient
            the link below another way, or open the patient and send a new link.
          </p>
        </div>
      )}
      <p className="muted">The link works until {formatDateTime(sent.expiresAt)}.</p>
      <details open={!sent.emailSent}>
        <summary>Show the patient's link</summary>
        <div className="stack">
          <p className="hint">
            This is the only time the link is shown. Anyone who has it can open the patient's videos, so share it only with
            the patient.
          </p>
          <input readOnly value={sent.watchUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Patient's link" />
          <button type="button" className="button secondary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      </details>
      <div className="controls">
        <Link to={`/doctor/patients/${encodeURIComponent(sent.prescriptionId)}`} className="button secondary" onNavigate={onClose}>View patient</Link>
        <button className="button" onClick={onAgain}>Invite another</button>
      </div>
    </div>
  );
}
