import { FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Turnstile } from './Turnstile';

// Before the videos, the patient proves they can read the email the doctor
// used, with a 6-digit code. Two plain steps, one at a time, with the step
// they're on always shown: 1. get the code by email, 2. type it in.
export function VerifyIdentity({ token, destination, onVerified }: {
  token: string;
  destination: string;
  onVerified: () => void;
}) {
  const base = `/api/watch/${encodeURIComponent(token)}`;
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [step, setStep] = useState<1 | 2>(1);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const [showResend, setShowResend] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 2) codeRef.current?.focus();
  }, [step]);

  const send = async (again: boolean) => {
    if (captcha === null) return;
    setSending(true);
    setError('');
    try {
      await api(`${base}/otp/send`, { json: { turnstileToken: captcha } });
      setStep(2);
      setCode('');
      setResent(again);
      setShowResend(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'We could not send the code. Please try again.');
    } finally {
      setSending(false);
      setResetKey((k) => k + 1); // each bot-check token works once
    }
  };

  const verify = async (value: string) => {
    if (!/^\d{6}$/.test(value)) {
      setError('The code is 6 numbers. Please check your email and try again.');
      return;
    }
    setVerifying(true);
    setError('');
    try {
      await api(`${base}/otp/verify`, { json: { code: value } });
      onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'We could not check the code. Please try again.');
      setCode('');
      codeRef.current?.focus();
    } finally {
      setVerifying(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    verify(code);
  };

  // Typing or pasting the sixth number checks the code straight away.
  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !verifying) verify(digits);
  };

  return (
    <div className="card verify-card">
      <h1>Welcome. Let's confirm it's you.</h1>
      <p className="verify-lead">
        Your doctor has shared videos with you. To keep them private, we'll email you a code. There's no password, and you
        don't need to type your email address.
      </p>

      <ol className="verify-steps" aria-label="Steps">
        <li className={step === 1 ? 'now' : 'done'}><span>{step === 1 ? '1' : '✓'}</span> Get your code</li>
        <li className={step === 2 ? 'now' : ''}><span>2</span> Type the code</li>
        <li><span>3</span> Watch your videos</li>
      </ol>

      {step === 1 ? (
        <section className="verify-step" aria-labelledby="step1">
          <h2 id="step1">Step 1: Get your code by email</h2>
          <p>
            Press the button below. We'll send a 6-number code to <strong>{destination}</strong>, the email your doctor's
            office has for you.
          </p>
          <Turnstile onToken={setCaptcha} onError={setError} resetKey={resetKey} />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button big" onClick={() => send(false)} disabled={sending || captcha === null}>
            {sending ? 'Sending…' : captcha === null ? 'One moment…' : 'Email me my code'}
          </button>
        </section>
      ) : (
        <section className="verify-step" aria-labelledby="step2">
          <h2 id="step2">Step 2: Type the code from your email</h2>
          <p>
            {resent ? 'We sent a new code' : 'We sent a code'} to <strong>{destination}</strong>. Open that email, find the
            6-number code, and type it in the box below. It works for 10 minutes.
          </p>
          <form onSubmit={onSubmit} className="stack">
            <label htmlFor="code" className="code-label">Your 6-number code</label>
            <input
              id="code"
              ref={codeRef}
              className="code-input big"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => onChange(e.target.value)}
              aria-describedby="code-help"
            />
            <p id="code-help" className="hint" style={{ marginTop: 0 }}>Numbers only. You can also paste it.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button big" type="submit" disabled={verifying || code.length !== 6}>
              {verifying ? 'Checking…' : 'Continue to my videos'}
            </button>
          </form>

          <div className="verify-help">
            <p><strong>No email?</strong> Wait a minute, then check your spam or junk folder.</p>
            {showResend ? (
              <div className="stack">
                <Turnstile onToken={setCaptcha} onError={setError} resetKey={resetKey} />
                <button className="button secondary" onClick={() => send(true)} disabled={sending || captcha === null}>
                  {sending ? 'Sending…' : 'Send me a new code'}
                </button>
              </div>
            ) : (
              <button className="link-button" onClick={() => { setShowResend(true); setCaptcha(null); setResetKey((k) => k + 1); }}>
                Still nothing? Send me a new code
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
