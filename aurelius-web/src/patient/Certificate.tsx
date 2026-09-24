import { useEffect, useState } from 'react';
import { ApiError, api, formatDateTime, formatDuration } from '../api';

interface CertificateResponse {
  verificationCode: string;
  certificate: {
    certificate_id: string;
    issued_at: string;
    completed_at: string;
    patient: { name: string; identity_verification: { destination: string; verified_at: string } };
    procedure: { name: string };
    prescribed_by: { name: string };
    videos: Array<{
      order: number;
      title: string;
      duration_seconds: number;
      completed_at: string;
      watch: { credited_seconds: number; attention_checks_passed: number; seek_blocked: number; pauses: number };
    }>;
    total_seek_attempts: number;
    total_seek_blocked: number;
    audit_log: { event_count: number };
    signature: { key_id: string };
  };
}

// The certificate of completion, laid out for printing (or saving as PDF
// from the browser's print dialog).
export function Certificate({ token, onBack }: { token: string; onBack: () => void }) {
  const [data, setData] = useState<CertificateResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<CertificateResponse>(`/api/watch/${encodeURIComponent(token)}/certificate`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the certificate.'));
  }, [token]);

  if (error) return <div className="card"><p className="error">{error}</p><button className="button" onClick={onBack}>Back</button></div>;
  if (!data) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const c = data.certificate;
  const verifyUrl = `${location.origin}/verify/${data.verificationCode}`;
  return (
    <div className="stack">
      <div className="no-print row">
        <button className="link-button" onClick={onBack}>← All videos</button>
        <button className="button" onClick={() => window.print()}>Print or save as PDF</button>
      </div>

      <article className="certificate">
        <p className="cert-brand">Aurelius</p>
        <h1>Certificate of Completion</h1>
        <p className="cert-lead">This certifies that</p>
        <p className="cert-name">{c.patient.name}</p>
        <p className="cert-lead">watched every video prescribed for</p>
        <p className="cert-procedure">{c.procedure.name}</p>
        <p className="muted">
          Prescribed by {c.prescribed_by.name}. Completed {formatDateTime(c.completed_at)}.
        </p>

        <table className="cert-table">
          <thead>
            <tr><th>#</th><th>Video</th><th>Length</th><th>Completed</th><th>Checks passed</th></tr>
          </thead>
          <tbody>
            {c.videos.map((v) => (
              <tr key={v.order}>
                <td>{v.order}</td>
                <td>{v.title}</td>
                <td>{formatDuration(v.duration_seconds)}</td>
                <td>{formatDateTime(v.completed_at)}</td>
                <td>{v.watch.attention_checks_passed}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="cert-facts">
          <dt>Identity</dt>
          <dd>Verified by one-time code sent to {c.patient.identity_verification.destination}</dd>
          <dt>Pacing</dt>
          <dd>
            Each video was released by the server no faster than real time, so it could not be skipped. Skip attempts:{' '}
            {c.total_seek_attempts} stopped by the player, {c.total_seek_blocked} refused by the server.
          </dd>
          <dt>Record</dt>
          <dd>Signed (Ed25519, key {c.signature.key_id}); audit log of {c.audit_log.event_count} events.</dd>
        </dl>

        <div className="cert-code">
          <p className="muted">Verification code</p>
          <p className="code">{data.verificationCode}</p>
          <p className="muted">Check this certificate at {verifyUrl}</p>
        </div>
      </article>
    </div>
  );
}
