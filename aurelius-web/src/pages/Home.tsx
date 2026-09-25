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
      <section className="hero">
        <h1>Short videos from your doctor, so you know what to expect.</h1>
        <p className="muted">
          Aurelius Code sends patients the videos for their procedure before they consent, and gives their doctor a signed
          record that every video was watched in full.
        </p>
        <p><strong>Patients:</strong> open the link in the email from your doctor's office to get started.</p>
        <div className="controls" style={{ marginTop: 0 }}>
          <a href="/doctor" className="button" style={{ flex: '0 0 auto' }}>Doctor sign in</a>
        </div>
      </section>

      <section className="stack">
        <h2>How it works</h2>
        <ol className="steps">
          <li><span className="step-num">1</span><strong>Doctor invites</strong><span>Choose the procedure and enter the patient's email.</span></li>
          <li><span className="step-num">2</span><strong>Patient confirms</strong><span>A one-time code by email confirms it's them.</span></li>
          <li><span className="step-num">3</span><strong>Videos, in order</strong><span>Each unlocks after the last. Skipping ahead is blocked.</span></li>
          <li><span className="step-num">4</span><strong>Signed certificate</strong><span>Anyone can check it with its verification code.</span></li>
        </ol>
      </section>

      <form className="card stack" onSubmit={go}>
        <h2>Check a certificate</h2>
        <label htmlFor="vcode">Verification code</label>
        <input id="vcode" placeholder="AUR-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
        <button className="button" type="submit" disabled={!code.trim()}>Check</button>
      </form>
    </div>
  );
}
