import { FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Turnstile } from './Turnstile';

// Step 1 for the patient: prove control of the email address the doctor
// entered, with a 6-digit code.
export function VerifyIdentity({ token, destination, onVerified }: {
  token: string;
  destination: string;
  onVerified: () => void;
}) {
  const base = `/api/watch/${encodeURIComponent(token)}`;
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const send = async () => {
    if (captcha === null) return;
    setSending(true);
    setError('');
    setInfo('');
    try {
      await api(`${base}/otp/send`, { json: { turnstileToken: captcha } });
      setSent(true);
      setInfo(`We sent a 6-digit code to ${destination}. It expires in 10 minutes.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the code.');
    } finally {
      setSending(false);
      setResetKey((k) => k + 1); // each bot-check token works once
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setVerifying(true);
    setError('');
    try {
      await api(`${base}/otp/verify`, { json: { code } });
      onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.');
      setCode('');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="card">
      <h1>Confirm it's you</h1>
      <p>
        Your doctor has shared some videos with you. To protect your privacy, we'll email a 6-digit code to{' '}
        <strong>{destination}</strong>.
      </p>

      {sent && (
        <form onSubmit={verify} className="stack">
          <label htmlFor="code">Code from your email</label>
          <input
            id="code"
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          <button className="button" type="submit" disabled={verifying || code.length !== 6}>
            {verifying ? 'Checking…' : 'Continue'}
          </button>
        </form>
      )}

      {info && <p className="note">{info}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="stack">
        <Turnstile onToken={setCaptcha} onError={setError} resetKey={resetKey} />
        <button className={sent ? 'button secondary' : 'button'} onClick={send} disabled={sending || captcha === null}>
          {sending ? 'Sending…' : sent ? 'Send a new code' : 'Email me a code'}
        </button>
      </div>
    </div>
  );
}
