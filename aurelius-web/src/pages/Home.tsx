import { FormEvent, useState } from 'react';

export function Home() {
  const [code, setCode] = useState('');
  const go = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c) location.assign(`/verify/${encodeURIComponent(c)}`);
  };
  return (
    <div className="stack-lg">
      <div className="card">
        <h1>Aurelius</h1>
        <p>Short videos from your doctor that explain your procedure, so you know what to expect before you consent.</p>
        <p><strong>Patients:</strong> open the link in the email from your doctor's office to get started.</p>
      </div>
      <form className="card stack" onSubmit={go}>
        <h2>Check a certificate</h2>
        <label htmlFor="vcode">Verification code</label>
        <input id="vcode" placeholder="AUR-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
        <button className="button" type="submit" disabled={!code.trim()}>Check</button>
      </form>
    </div>
  );
}
