import { FormEvent, useEffect, useState } from 'react';
import { ApiError, formatDateTime } from '../api';
import { Link, doctorApi } from './nav';

interface Procedure { id: string; name: string; video_count: number }
interface Sent { prescriptionId: string; watchUrl: string; expiresAt: string; emailSent: boolean; patientName: string; patientEmail: string }

export function Prescribe() {
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [procedureId, setProcedureId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Sent | null>(null);

  useEffect(() => {
    doctorApi<Procedure[]>('/procedures')
      .then((list) => setProcedures(list.filter((p) => p.video_count > 0)))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load procedures.'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await doctorApi<Omit<Sent, 'patientName' | 'patientEmail'>>('/prescribe', {
        json: { patient_name: name.trim(), patient_email: email.trim(), procedure_id: procedureId },
      });
      setSent({ ...r, patientName: name.trim(), patientEmail: email.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the prescription.');
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setSent(null);
    setName('');
    setEmail('');
    setProcedureId('');
  };

  if (sent) return <SentCard sent={sent} onAnother={startOver} />;
  if (!procedures && !error) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const procedure = procedures?.find((p) => p.id === procedureId);
  return (
    <form className="card stack narrow" onSubmit={submit}>
      <h1>New prescription</h1>
      <p className="muted">The patient gets an email with a link to the procedure's videos. The link works for 48 hours.</p>

      <label htmlFor="pname">Patient's full name</label>
      <input id="pname" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />

      <label htmlFor="pemail">Patient's email</label>
      <input id="pemail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <p className="hint">Check it carefully: the link and the sign-in codes go to this address.</p>

      <label htmlFor="proc">Procedure</label>
      <select id="proc" value={procedureId} onChange={(e) => setProcedureId(e.target.value)} required>
        <option value="" disabled>Choose a procedure</option>
        {procedures?.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.video_count} videos)</option>
        ))}
      </select>

      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy || !name.trim() || !email.trim() || !procedureId}>
        {busy ? 'Sending…' : procedure ? `Send ${procedure.name} videos` : 'Send videos'}
      </button>
    </form>
  );
}

function SentCard({ sent, onAnother }: { sent: Sent; onAnother: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sent.watchUrl);
      setCopied(true);
    } catch {}
  };
  return (
    <div className="card stack narrow">
      {sent.emailSent ? (
        <div className="banner success">
          <p><strong>Sent.</strong> {sent.patientName} will get an email at {sent.patientEmail} with their link.</p>
        </div>
      ) : (
        <div className="banner danger">
          <p>
            <strong>The prescription was created, but the email to {sent.patientEmail} failed to send.</strong> Give the patient
            the link below another way, or open the patient and resend it.
          </p>
        </div>
      )}
      <p>The link works until {formatDateTime(sent.expiresAt)}.</p>

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
        <Link to={`/doctor/patients/${encodeURIComponent(sent.prescriptionId)}`} className="button secondary">View patient</Link>
        <button className="button" onClick={onAnother}>Prescribe another</button>
      </div>
    </div>
  );
}
