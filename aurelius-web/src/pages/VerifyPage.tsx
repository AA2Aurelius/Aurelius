import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';

type Result =
  | { status: 'valid'; procedure: string; completed_on: string; patient_initials: string }
  | { status: 'tampered' }
  | { status: 'not_found' };

// Public check of a certificate's verification code. Shows only whether it
// is genuine, the procedure, the completion date and the patient's initials.
export function VerifyPage({ code }: { code: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Result>(`/api/verify/${encodeURIComponent(code)}`)
      .then(setResult)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setResult({ status: 'not_found' });
        else setError(err instanceof ApiError ? err.message : 'Could not check this code.');
      });
  }, [code]);

  return (
    <div className="card">
      <h1>Certificate check</h1>
      <p className="muted code">{code}</p>
      {error && <p className="error">{error}</p>}
      {!result && !error && <div className="spinner" aria-label="Checking" />}
      {result?.status === 'valid' && (
        <div className="banner success">
          <p><strong>✓ Genuine certificate.</strong> Its signature and audit record check out.</p>
          <dl className="cert-facts">
            <dt>Procedure</dt><dd>{result.procedure}</dd>
            <dt>Completed</dt><dd>{new Date(result.completed_on + 'T00:00:00Z').toLocaleDateString(undefined, { dateStyle: 'long', timeZone: 'UTC' })}</dd>
            <dt>Patient</dt><dd>{result.patient_initials}</dd>
          </dl>
        </div>
      )}
      {result?.status === 'tampered' && (
        <div className="banner danger"><strong>This certificate failed verification.</strong> Its record has been altered and it should not be relied on.</div>
      )}
      {result?.status === 'not_found' && (
        <div className="banner warning"><strong>No certificate has this code.</strong> Check it was typed correctly.</div>
      )}
      <p><a href="/">Check another code</a></p>
    </div>
  );
}
