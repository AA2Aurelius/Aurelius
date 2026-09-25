import { FormEvent, useState, type ReactNode } from 'react';
import { CardIcon, CheckBoxIcon, GridIcon, HelpIcon, InviteIcon, VerifiedIcon } from '../components/icons';

// The home page, after the Scope of Work wireframe: blue hero, procedures,
// how it works, pricing, about, and a sign-up band.

// Only the live procedures have videos today; the rest are listed so
// visitors can see what's coming. Live ones list their actual videos.
const PROCEDURES: Array<{ name: string; live?: boolean; blurb: string; items?: string[] }> = [
  {
    name: 'Spinal Fusion', live: true, blurb: '6 videos, watched in order',
    items: ['Preparing your home', 'Pre-op', 'What to expect in hospital', 'The procedure', 'Risks', 'Hospital care'],
  },
  {
    name: 'Hip Replacement', live: true, blurb: '6 videos, watched in order',
    items: ['Replacement surgery', 'Risks', 'How to prepare for surgery', 'During the procedure', 'After the procedure', 'Home recovery'],
  },
  { name: 'Appendectomy', blurb: 'Removal of the appendix' },
  { name: 'Cesarean Delivery', blurb: 'Delivering a baby by surgery' },
  { name: 'Circumcision', blurb: 'Before, during and after' },
  { name: 'Coronary Artery Bypass Surgery', blurb: 'Rerouting blood around blocked arteries' },
  { name: 'Gallbladder Removal', blurb: 'Removal of the gallbladder' },
  { name: 'Heart Valve Surgery', blurb: 'Repairing or replacing a heart valve' },
  { name: 'Hip Dysplasia', blurb: 'Surgery to correct the hip socket' },
  { name: 'Knee Replacement', blurb: 'Replacing a worn knee joint' },
  { name: 'Laminectomy', blurb: 'Relieving pressure on the spinal cord' },
  { name: 'Pacemakers', blurb: 'Fitting a pacemaker to steady the heartbeat' },
  { name: 'Percutaneous Coronary Angioplasty', blurb: 'Opening a narrowed heart artery' },
  { name: 'Staph Infections', blurb: 'Preventing and treating infection' },
  { name: 'Vaginal Hysterectomy', blurb: 'Removal of the uterus' },
];
const SOON_ITEMS = ['What happens before surgery', 'The procedure, step by step', 'Risks, explained plainly', 'Recovery at home'];
const FIRST = 6;

// Prices from the Scope of Work wireframe.
const PLANS = [
  { name: 'Private Practice', patients: 'Up to 100 patients', month: 65.99, blurb: 'For a single doctor or a small office.', color: 'orange' },
  { name: 'Small Hospitals', patients: 'Up to 500 patients', month: 249, blurb: 'For a department or a small hospital.', color: 'amber' },
  { name: 'Large Hospitals', patients: 'Up to 1000 patients', month: 332, blurb: 'For hospitals with many surgeons.', color: 'gold' },
];

const STEPS: Array<{ label: string; icon: ReactNode; color: string }> = [
  { label: 'Get verified', icon: <VerifiedIcon />, color: 'orange' },
  { label: 'Pay', icon: <CardIcon />, color: 'blue' },
  { label: 'Access platform content', icon: <GridIcon />, color: 'green' },
  { label: 'Invite patients', icon: <InviteIcon />, color: 'pink' },
  { label: 'Provide help', icon: <HelpIcon />, color: 'purple' },
];

export function Home() {
  const [code, setCode] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [yearly, setYearly] = useState(false);
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
          <path d="M60 18 L100 32 V68 C100 96 82 114 60 122 C38 114 20 96 20 68 V32 Z" fill="#f1f4ff" />
          <rect x="52" y="44" width="16" height="52" rx="3" fill="#d62828" />
          <rect x="34" y="62" width="52" height="16" rx="3" fill="#d62828" />
        </svg>
      </section>

      <section id="procedures" className="home-band light">
        <div className="home-inner home-section">
          <span className="home-kicker" aria-hidden="true" />
          <h2 className="home-h2">Procedures</h2>
          <p className="home-lead">
            Each procedure is a set of short videos, watched in order. The certificate is issued once the patient has watched
            them all. Spinal Fusion and Hip Replacement are live; more are on the way.
          </p>
          <div className="proc-grid">
            {shown.map((p) => (
              <article key={p.name} className={`proc-card ${p.live ? 'live' : 'soon'}`}>
                <span className={`proc-status ${p.live ? 'live' : ''}`}>{p.live ? '● Live' : 'Coming soon'}</span>
                <h3>{p.name}</h3>
                <p className="proc-sub">{p.blurb}</p>
                <ul className="proc-features">
                  {(p.items ?? SOON_ITEMS).map((f) => <li key={f}><CheckBoxIcon /> {f}</li>)}
                </ul>
                {p.live ? <a className="button small" href="/doctor">View videos</a> : <span className="proc-soon-note">Videos coming soon</span>}
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
        </div>
      </section>

      <section id="how" className="home-band white">
        <div className="home-inner how-grid">
          <div className="how-diagram" aria-hidden="true">
            {STEPS.map((s, i) => (
              <div key={s.label} className={`how-step ${i % 2 ? 'right' : 'left'}`}>
                <span className={`how-icon ${s.color}`}>{s.icon}</span>
                <span className="how-label">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="home-section">
            <span className="home-kicker" aria-hidden="true" />
            <h2 className="home-h2">How it works</h2>
            <ol className="how-list">
              <li><strong>Get verified.</strong> Your practice gets a doctor account with Aurelius Code.</li>
              <li><strong>Pay.</strong> Choose the plan that fits how many patients you see.</li>
              <li><strong>Access platform content.</strong> Every procedure's branded videos, ready to preview.</li>
              <li><strong>Invite patients.</strong> Enter the patient's email and choose their procedure. They get a 48-hour link.</li>
              <li>
                <strong>Provide help.</strong> The patient confirms it's them with a one-time code and watches every video in
                order; skipping ahead is blocked. When they finish, both of you get a signed certificate anyone can check.
              </li>
            </ol>
            <a className="button mint small" href="/doctor">Doctor sign in</a>
          </div>
        </div>
      </section>

      <section id="pricing" className="home-band blue">
        <div className="home-inner home-section">
          <div className="pricing-head">
            <div>
              <span className="home-kicker" aria-hidden="true" />
              <h2 className="home-h2">Pricing</h2>
              <p className="home-lead">Every time you share the videos with a patient, it counts.</p>
            </div>
            <div className="toggle" role="group" aria-label="Billing">
              <button aria-pressed={!yearly} className={!yearly ? 'on' : ''} onClick={() => setYearly(false)}>Month</button>
              <button aria-pressed={yearly} className={yearly ? 'on' : ''} onClick={() => setYearly(true)}>Year</button>
            </div>
          </div>
          <div className="price-grid">
            {PLANS.map((p) => (
              <article key={p.name} className="price-card">
                <span className={`how-icon ${p.color}`} aria-hidden="true"><GridIcon /></span>
                <h3>{p.name}</h3>
                <p className="proc-sub">{p.patients}</p>
                <p className="price-blurb">{p.blurb}</p>
                <p className="price">
                  ${(yearly ? p.month * 12 : p.month).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  <small>/{yearly ? 'yr' : 'mo'}</small>
                </p>
                <a className="button mint small" href="#signup">Sign up</a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="about" className="home-band light about-grid">
        <div className="about-col">
          <span className="home-kicker" aria-hidden="true" />
          <h2 className="home-h2">Founder</h2>
          <p>
            Aurelius Code was founded by Antonius Aurelius to give every patient clear, honest videos about their procedure
            before they consent, and to give their doctor proof that the patient watched them.
          </p>
        </div>
        <div className="about-col">
          <span className="home-kicker" aria-hidden="true" />
          <h2 className="home-h2">Mission</h2>
          <p>
            Because everyone can use a little help from time to time. Patients who understand their surgery arrive prepared,
            recover with confidence, and consent knowing what to expect.
          </p>
        </div>
      </section>

      <section className="home-band white">
        <form id="check" className="home-inner card stack check-card" onSubmit={go}>
          <h2>Check a certificate</h2>
          <label htmlFor="vcode">Verification code</label>
          <input id="vcode" placeholder="AUR-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
          <button className="button" type="submit" disabled={!code.trim()}>Check</button>
        </form>
      </section>

      <section id="signup" className="home-band blue signup-band">
        <div className="home-inner signup-inner">
          <h2 className="home-h2">Sign up now and invite patients</h2>
          <a className="button ghost small" href="/doctor">Doctor sign in</a>
        </div>
      </section>
    </div>
  );
}
