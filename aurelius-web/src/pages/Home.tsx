import { FormEvent, useState } from 'react';

// The procedures shown on the home page. Only the live ones have videos
// today; the rest are listed so visitors can see what's coming.
const PROCEDURES: Array<{ name: string; live?: boolean; blurb: string }> = [
  { name: 'Spinal Fusion', live: true, blurb: 'Preparing your home, pre-op, the hospital stay, the procedure, risks and care.' },
  { name: 'Hip Replacement', live: true, blurb: 'The surgery, its risks, how to prepare and what happens during it.' },
  { name: 'Appendectomy', blurb: 'Removal of the appendix.' },
  { name: 'Cesarean Delivery', blurb: 'Delivering a baby by surgery.' },
  { name: 'Circumcision', blurb: 'What happens before, during and after.' },
  { name: 'Coronary Artery Bypass Surgery', blurb: 'Rerouting blood around blocked heart arteries.' },
  { name: 'Gallbladder Removal', blurb: 'Removal of the gallbladder.' },
  { name: 'Heart Valve Surgery', blurb: 'Repairing or replacing a heart valve.' },
  { name: 'Hip Dysplasia', blurb: 'Surgery to correct the hip socket.' },
  { name: 'Knee Replacement', blurb: 'Replacing a worn knee joint.' },
  { name: 'Laminectomy', blurb: 'Relieving pressure on the spinal cord.' },
  { name: 'Pacemakers', blurb: 'Fitting a pacemaker to steady the heartbeat.' },
  { name: 'Percutaneous Coronary Angioplasty', blurb: 'Opening a narrowed heart artery.' },
  { name: 'Staph Infections', blurb: 'Preventing and treating infection.' },
  { name: 'Vaginal Hysterectomy', blurb: 'Removal of the uterus.' },
];
const FIRST = 6;

export function Home() {
  const [code, setCode] = useState('');
  const [showAll, setShowAll] = useState(false);
  const go = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c) location.assign(`/verify/${encodeURIComponent(c)}`);
  };
  const shown = showAll ? PROCEDURES : PROCEDURES.slice(0, FIRST);
  return (
    <div className="home">
      <section className="home-hero">
        <div className="home-hero-inner">
          <h1>Because everyone can use a little help from time to time</h1>
          <p>
            Short, branded videos from your doctor, so you know what to expect. Aurelius Code sends patients the videos for
            their procedure before they consent, and gives their doctor a signed record that every video was watched in full.
          </p>
          <p><strong>Patients:</strong> open the link in the email from your doctor's office to get started.</p>
          <div className="home-hero-actions">
            <a href="/doctor" className="button mint">Doctor sign in</a>
            <a href="#check" className="button ghost">Check a certificate</a>
          </div>
        </div>
        <svg className="home-shield" viewBox="0 0 120 140" aria-hidden="true">
          <path d="M60 6 L110 24 V68 C110 102 88 124 60 134 C32 124 10 102 10 68 V24 Z" fill="#fff" stroke="#dfe6ff" strokeWidth="3" />
          <path d="M60 18 L100 32 V68 C100 96 82 114 60 122 C38 114 20 96 20 68 V32 Z" fill="#eef2ff" />
          <rect x="52" y="44" width="16" height="52" rx="3" fill="#d62828" />
          <rect x="34" y="62" width="52" height="16" rx="3" fill="#d62828" />
        </svg>
      </section>

      <div className="home-body">
        <section className="home-section">
          <span className="home-kicker" aria-hidden="true" />
          <h2 className="home-h2">Procedures</h2>
          <p className="muted home-lead">
            Each procedure is a set of short videos, watched in order. The certificate is issued once the patient has watched
            them all. Spinal Fusion and Hip Replacement are live; more are on the way.
          </p>
          <div className="proc-grid">
            {shown.map((p) => (
              <article key={p.name} className={`proc-card ${p.live ? 'live' : 'soon'}`}>
                <span className={`proc-status ${p.live ? 'live' : ''}`}>{p.live ? '● Live' : 'Coming soon'}</span>
                <h3>{p.name}</h3>
                <p>{p.blurb}</p>
                {p.live ? (
                  <a className="button small" href="/doctor">View videos</a>
                ) : (
                  <span className="proc-soon-note">Videos coming soon</span>
                )}
              </article>
            ))}
          </div>
          {PROCEDURES.length > FIRST && (
            <div className="home-more">
              <button className="button mint small" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `${PROCEDURES.length - FIRST} more procedures`}
              </button>
            </div>
          )}
        </section>

        <section className="home-section">
          <span className="home-kicker" aria-hidden="true" />
          <h2 className="home-h2">How it works</h2>
          <ol className="steps">
            <li><span className="step-num">1</span><strong>Doctor invites</strong><span>Choose the procedure and enter the patient's email.</span></li>
            <li><span className="step-num">2</span><strong>Patient confirms</strong><span>A one-time code by email confirms it's them.</span></li>
            <li><span className="step-num">3</span><strong>Videos, in order</strong><span>Each unlocks after the last. Skipping ahead is blocked.</span></li>
            <li><span className="step-num">4</span><strong>Signed certificate</strong><span>Anyone can check it with its verification code.</span></li>
          </ol>
        </section>

        <form id="check" className="card stack home-section" onSubmit={go}>
          <h2>Check a certificate</h2>
          <label htmlFor="vcode">Verification code</label>
          <input id="vcode" placeholder="AUR-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
          <button className="button" type="submit" disabled={!code.trim()}>Check</button>
        </form>
      </div>
    </div>
  );
}
