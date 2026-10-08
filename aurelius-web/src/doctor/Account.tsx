import { FormEvent, useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, api, formatDate } from '../api';
import { doctorApi } from './nav';

// Two-step sign-in (Security), the practice's people (Team), and joining a
// practice from an emailed invitation.

function message(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

// The authenticator code asked for after the password.
export function MfaSignIn({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ usedRecoveryCode?: boolean; recoveryCodesLeft?: number }>('/api/doctor/login/mfa', { json: { code } });
      if (r.usedRecoveryCode) {
        alert(`You signed in with a recovery code. ${r.recoveryCodesLeft} left. You can make new ones under Security.`);
      }
      onDone();
    } catch (err) {
      setError(message(err, 'Could not check the code.'));
      if (err instanceof ApiError && err.status === 401) onCancel();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack narrow" onSubmit={submit}>
      <h1>Two-step sign-in</h1>
      <p className="muted" style={{ margin: 0 }}>
        {recovery ? 'Type one of the recovery codes you saved when you set this up.' : 'Open your authenticator app and type the 6-digit code for Aurelius Code.'}
      </p>
      <label htmlFor="mfa-code">{recovery ? 'Recovery code' : '6-digit code'}</label>
      <input
        id="mfa-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoFocus
        maxLength={recovery ? 12 : 6}
        placeholder={recovery ? 'XXXX-XXXX' : '123456'}
        required
      />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Sign in'}</button>
      <button type="button" className="link-button" onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>
        {recovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}
      </button>
      <button type="button" className="link-button" onClick={onCancel}>← Back to sign in</button>
    </form>
  );
}

// /doctor/join/{token}: choose a password and join the practice.
export function JoinPractice({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [invite, setInvite] = useState<{ name: string; email: string; role: string; practice: string } | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof invite>(`/api/doctor/join/${encodeURIComponent(token)}`).then(setInvite).catch((err) => setError(message(err, 'This invitation could not be opened.')));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords are different.');
    setBusy(true);
    setError('');
    try {
      await api(`/api/doctor/join/${encodeURIComponent(token)}`, { json: { password } });
      history.replaceState(null, '', '/doctor');
      onJoined();
    } catch (err) {
      setError(message(err, 'Could not create your account.'));
      setBusy(false);
    }
  };
  if (error && !invite) return <div className="card stack narrow"><h1>Invitation</h1><p className="error">{error}</p></div>;
  if (!invite) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  return (
    <form className="card stack narrow" onSubmit={submit}>
      <h1>Join {invite.practice}</h1>
      <p className="muted" style={{ margin: 0 }}>
        Welcome, {invite.name}. You're joining as {invite.role === 'doctor' ? 'a doctor' : 'staff'}. You'll sign in with <strong>{invite.email}</strong>.
      </p>
      <label htmlFor="join-pw">Choose a password (at least 12 characters)</label>
      <input id="join-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required />
      <label htmlFor="join-pw2">Type it again</label>
      <input id="join-pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy || password.length < 12}>{busy ? 'Creating your account…' : 'Create my account'}</button>
    </form>
  );
}

function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return <div className="mfa-qr" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) }} />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <div className="banner warning">
        <p>
          <strong>Save these recovery codes now.</strong> If you lose your phone, each one lets you sign in once. They won't be shown
          again. Keep them somewhere safe, such as a password manager or a printed copy in a locked drawer.
        </p>
      </div>
      <ol className="recovery-codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
      <div className="controls">
        <button
          className="button secondary"
          onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true)).catch(() => {})}
        >
          {copied ? 'Copied' : 'Copy the codes'}
        </button>
        <button className="button" onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

// /doctor/security, and the forced setup when the practice requires it.
export function Security({ forced, onEnabled }: { forced?: boolean; onEnabled?: () => void }) {
  const [state, setState] = useState<{ enabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => doctorApi<NonNullable<typeof state>>('/mfa').then(setState).catch((err) => setError(message(err, 'Could not load.')));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(message(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };
  if (!state) return error ? <div className="card"><p className="error">{error}</p></div> : <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  if (codes) {
    return (
      <section className="card stack narrow-wide">
        <h1 style={{ margin: 0 }}>Two-step sign-in is on</h1>
        <RecoveryCodes codes={codes} onDone={() => { setCodes(null); setPassword(''); load(); onEnabled?.(); }} />
      </section>
    );
  }

  return (
    <section className="card stack narrow-wide">
      <h1 style={{ margin: 0 }}>Security</h1>
      {forced && (
        <div className="banner warning"><p><strong>Your practice requires two-step sign-in.</strong> Set it up to continue.</p></div>
      )}
      <h2 style={{ margin: 0 }}>Two-step sign-in</h2>
      <p className="muted" style={{ margin: 0 }}>
        After your password, you'll also type a code from an authenticator app on your phone (Google Authenticator, Microsoft
        Authenticator, 1Password, Authy or similar). Someone who learns your password still can't sign in.
      </p>

      {state.enabled ? (
        <>
          <div className="banner success"><p><strong>✓ On</strong>{state.enabledAt ? ` since ${formatDate(state.enabledAt)}` : ''}. {state.recoveryCodesLeft} recovery codes left.</p></div>
          <label htmlFor="sec-pw">Your password, to make changes</label>
          <input id="sec-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="controls">
            <button className="button secondary" disabled={busy || !password} onClick={() => run(async () => {
              const r = await doctorApi<{ recoveryCodes: string[] }>('/mfa/recovery-codes', { json: { password } });
              setCodes(r.recoveryCodes);
            })}>Make new recovery codes</button>
            {!state.required && (
              <button className="button secondary danger-text" disabled={busy || !password} onClick={() => run(async () => {
                await doctorApi('/mfa/disable', { json: { password } });
                setPassword('');
                await load();
              })}>Turn off two-step sign-in</button>
            )}
          </div>
          {state.required && <p className="note">Your practice requires two-step sign-in, so it can't be turned off.</p>}
        </>
      ) : setup ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => {
          const r = await doctorApi<{ recoveryCodes: string[] }>('/mfa/enable', { json: { code } });
          setSetup(null);
          setCode('');
          setCodes(r.recoveryCodes);
        }); }}>
          <ol className="mfa-steps">
            <li>Open your authenticator app and add an account (often a <strong>+</strong> button).</li>
            <li>Scan this code with your phone's camera:
              <Qr text={setup.uri} />
              <span className="muted">Can't scan? Type this key instead: <code className="mfa-key">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></span>
            </li>
            <li>Type the 6-digit code the app now shows for Aurelius Code:</li>
          </ol>
          <input aria-label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
          <button className="button" type="submit" disabled={busy || code.trim().length !== 6}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
        </form>
      ) : (
        <button className="button" disabled={busy} onClick={() => run(async () => setSetup(await doctorApi('/mfa/setup', { json: {} })))}>Set up two-step sign-in</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

interface TeamData {
  practice: { id: string; name: string; requireMfa: boolean } | null;
  members: Array<{ id: string; name: string; email: string; role: string; mfa: boolean; disabled: boolean; me: boolean }>;
  invites: Array<{ id: string; name: string; email: string; role: string; created_at: string; expires_at: string }>;
}

// /doctor/team: who's in the practice, and adding people.
export function Team({ role }: { role: 'doctor' | 'staff' }) {
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ name: '', email: '', role: 'staff', practice_name: '' });
  const [busy, setBusy] = useState(false);
  const load = () => doctorApi<TeamData>('/team').then(setData).catch((err) => setError(message(err, 'Could not load the team.')));
  useEffect(() => { load(); }, []);
  const canManage = role === 'doctor';

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (err) {
      setError(message(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };
  if (!data) return error ? <div className="card"><p className="error">{error}</p></div> : <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  return (
    <div className="stack-lg">
      <h1 style={{ margin: 0 }}>{data.practice ? data.practice.name : 'Your team'}</h1>
      <p className="muted" style={{ margin: 0 }}>
        Everyone in the practice sees its invites and can follow each patient's progress. Staff send invites on a doctor's behalf;
        the invite and certificate always name the doctor.
      </p>
      {notice && <div className="banner success"><p>{notice}</p></div>}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>People</h2>
        <div className="history-wrap">
          <table className="history-table team-table">
            <thead><tr><th>Name</th><th>Role</th><th>Two-step sign-in</th><th>Access</th></tr></thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id} className={m.disabled ? 'faint' : ''}>
                  <td><span className="h-name">{m.name}{m.me ? ' (you)' : ''}</span><span className="h-email">{m.email}</span></td>
                  <td>{m.role === 'doctor' ? 'Doctor' : 'Staff'}</td>
                  <td>{m.mfa ? <span className="h-status ok">✓ On</span> : <span className="h-status wait">Off</span>}</td>
                  <td>
                    {m.disabled ? 'Turned off' : canManage && !m.me && data.practice ? (
                      <button className="button small secondary danger-text" disabled={busy} onClick={() => {
                        if (confirm(`Turn off ${m.name}'s access? They are signed out now and can't sign in again.`)) act(() => doctorApi(`/team/${encodeURIComponent(m.id)}/disable`, { json: {} }), `${m.name}'s access is turned off.`);
                      }}>Turn off access</button>
                    ) : 'Active'}
                  </td>
                </tr>
              ))}
              {data.invites.map((i) => (
                <tr key={i.id}>
                  <td><span className="h-name">{i.name}</span><span className="h-email">{i.email}</span></td>
                  <td>{i.role === 'doctor' ? 'Doctor' : 'Staff'}</td>
                  <td colSpan={2}>
                    Invited, not joined yet (link works until {formatDate(i.expires_at)})
                    {canManage && <> · <button className="link-button inline" disabled={busy} onClick={() => act(() => doctorApi(`/team/invites/${i.id}/cancel`, { json: {} }), 'Invitation cancelled.')}>Cancel</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canManage && (
        <section className="card stack narrow-wide">
          <h2 style={{ margin: 0 }}>Add someone</h2>
          <p className="muted" style={{ margin: 0 }}>They get an email with a link to choose their password.</p>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            act(() => doctorApi('/team/invite', { json: form }), `Invitation emailed to ${form.email}.`).then(() => setForm({ ...form, name: '', email: '' }));
          }}>
            {!data.practice && (
              <>
                <label htmlFor="t-practice">Your practice's name</label>
                <input id="t-practice" value={form.practice_name} onChange={(e) => setForm({ ...form, practice_name: e.target.value })} placeholder="e.g. Smith Orthopedics" />
              </>
            )}
            <label htmlFor="t-name">Their name</label>
            <input id="t-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
            <label htmlFor="t-email">Their email</label>
            <input id="t-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <fieldset className="role-pick">
              <legend>Role</legend>
              <label><input type="radio" name="role" checked={form.role === 'staff'} onChange={() => setForm({ ...form, role: 'staff' })} /> Staff: sends invites on a doctor's behalf</label>
              <label><input type="radio" name="role" checked={form.role === 'doctor'} onChange={() => setForm({ ...form, role: 'doctor' })} /> Doctor: patients' invites can come from them</label>
            </fieldset>
            <button className="button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button>
          </form>
        </section>
      )}

      {canManage && data.practice && (
        <section className="card stack narrow-wide">
          <h2 style={{ margin: 0 }}>Practice settings</h2>
          <label className="check-row">
            <input type="checkbox" checked={data.practice.requireMfa} disabled={busy} onChange={(e) => act(
              () => doctorApi('/team/practice', { json: { require_mfa: e.target.checked } }),
              e.target.checked ? 'Two-step sign-in is now required for everyone in the practice.' : 'Two-step sign-in is now optional.',
            )} />
            <span>Require two-step sign-in for everyone in the practice</span>
          </label>
          <p className="note">Hospitals usually require this. Turn it on for yourself first, under Security.</p>
        </section>
      )}
    </div>
  );
}
