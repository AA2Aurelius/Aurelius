import { FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Turnstile } from '../patient/Turnstile';

// The home page's contact form, behind "Contact us" and "Sign up". `topic`
// is filled in by the button that brought the visitor here.
export function ContactForm({ topic, onTopic }: { topic: string; onTopic: (t: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [message, setMessage] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/public/contact', { json: { name, email, organization, topic, message, turnstileToken: captcha } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your message. Please try again.');
      setCaptcha(null);
      setResetKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="card stack contact-card" role="status">
        <h2>Thank you, {name.split(/\s+/)[0]}.</h2>
        <p>Your message reached us. We'll reply to {email} soon.</p>
        <button className="button secondary" onClick={() => { setSent(false); setMessage(''); }}>Send another message</button>
      </div>
    );
  }

  return (
    <form className="card stack contact-card" onSubmit={submit}>
      <h2>Contact us</h2>
      <p className="muted" style={{ margin: 0 }}>Questions, a demo, or signing up your practice: tell us a little and we'll get back to you.</p>
      <div className="contact-grid">
        <div>
          <label htmlFor="c-name">Your name</label>
          <input id="c-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </div>
        <div>
          <label htmlFor="c-email">Email</label>
          <input id="c-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
        </div>
        <div>
          <label htmlFor="c-org">Practice, hospital or company</label>
          <input id="c-org" autoComplete="organization" value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label htmlFor="c-topic">About</label>
          <select id="c-topic" value={topic} onChange={(e) => onTopic(e.target.value)}>
            {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="c-msg">Message</label>
      <textarea id="c-msg" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} required />
      <Turnstile onToken={setCaptcha} onError={setError} resetKey={resetKey} />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy || captcha === null || !name.trim() || !email.trim() || !message.trim()}>
        {busy ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

export const TOPICS = [
  'General question',
  'Sign up my practice',
  'Subscription: Private Practice',
  'Subscription: Small Hospitals',
  'Subscription: Large Hospitals',
  'Revenue share',
  'Loss prevention mandate',
];
