import { FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import type { Doctor } from './DoctorApp';

export function Login({ notice, intent, onSignedIn }: { notice: string; intent?: string; onSignedIn: (d: Doctor) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ doctor: Doctor }>('/api/doctor/login', { json: { email, password } });
      setPassword('');
      onSignedIn(r.doctor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack narrow" onSubmit={submit}>
      <h1>Doctor sign in</h1>
      {intent && <p className="muted" style={{ margin: 0 }}>{intent}</p>}
      {notice && <p className="banner"><span>{notice}</span></p>}
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="hint">Forgot your password? Ask your Aurelius administrator to reset it.</p>
    </form>
  );
}
