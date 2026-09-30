import type { ReactNode } from 'react';
import { MALPRACTICE_LOSSES, PAYER_LOSSES } from './Savings';

// Headline figures, rounded: "$314 billion", "$5.0 billion".
const big = (n: number) => `$${n >= 100e9 ? Math.round(n / 1e9) : (n / 1e9).toFixed(1)} billion`;

// The investor deck as one scrolling page, at /investors. It isn't linked
// from the site's menus; it's shared by link. The TEAM and COMING entries
// below are the parts most likely to change.

const TEAM = [
  'Aurelius Code was created by Antonius Aurelius. We are a group of dedicated voice-over artists, animators, surgical consultants, web developers, programmers and project managers.',
  'In our medical platform, our scripts are created in collaboration with surgical consultants.',
];

// The highest-volume surgical procedures, next in line for videos.
const COMING = [
  'Appendectomy', 'Cesarean Delivery', 'Circumcision', 'Coronary Artery Bypass Surgery', 'Gallbladder Removal',
  'Heart Valve Surgery', 'Hip Dysplasia', 'Knee Replacement', 'Laminectomy', 'Pacemakers',
  'Percutaneous Coronary Angioplasty', 'Staph Infections', 'Vaginal Hysterectomy',
];

// Without a title, the section name itself is the heading.
function Slide({ n, kicker, title, children, tone }: { n: number; kicker: string; title?: string; children: ReactNode; tone?: 'blue' }) {
  const num = <span>{String(n).padStart(2, '0')}</span>;
  return (
    <section className={`deck-slide ${tone === 'blue' ? 'blue' : ''}`} aria-labelledby={`slide-${n}`}>
      <div className="deck-inner">
        {title ? (
          <>
            <p className="deck-kicker">{num} {kicker}</p>
            <h2 id={`slide-${n}`} className="deck-title">{title}</h2>
          </>
        ) : (
          <h2 id={`slide-${n}`} className="deck-kicker deck-kicker-title">{num} {kicker}</h2>
        )}
        {children}
      </div>
    </section>
  );
}

export function InvestorsPage() {
  const malpractice = MALPRACTICE_LOSSES[0];
  let n = 0;
  return (
    <div className="deck">
      <header className="deck-cover">
        <div className="deck-inner">
          <p className="deck-cover-kicker">Investor overview · Confidential</p>
          <h1>Informed consent patients actually watch, and doctors can prove.</h1>
          <p className="deck-cover-sub">
            Aurelius Code sends patients short, branded videos about their procedure before they consent, makes sure every
            minute is watched, and gives their doctor a signed, verifiable certificate.
          </p>
          <div className="deck-cover-actions">
            <a className="button mint" href="#demo">Try the live demo</a>
            <a className="button ghost" href="/" target="_blank" rel="noopener">aureliuscode.com</a>
          </div>
        </div>
      </header>

      <nav className="deck-toc" aria-label="Sections">
        {['Problem', 'Solution', 'How it works', 'Why it holds up', 'Market', 'Business model', 'Traction', 'Team', 'Our next phase', 'Demo'].map((t, i) => (
          <a key={t} href={`#s${i + 1}`}>{t}</a>
        ))}
      </nav>

      <div id="s1">
        <Slide n={++n} kicker="The problem" title="Consent is signed, but rarely understood, and hard to prove.">
          <div className="deck-grid two">
            <div className="deck-card">
              <p className="deck-big">{big(malpractice.amount)}</p>
              <p>paid in U.S. medical malpractice claims in {malpractice.year} ({malpractice.what.toLowerCase()}).</p>
              <p className="deck-src">Source: <a href={malpractice.href} target="_blank" rel="noopener noreferrer">{malpractice.source}</a></p>
            </div>
            <ul className="deck-list">
              <li>Patients sign consent forms after a short conversation, and many don't remember what they were told.</li>
              <li>When outcomes disappoint, "I was never told" is hard to disprove. A signature doesn't show understanding.</li>
              <li>Paper handouts and optional videos have no record of whether they were read or watched.</li>
            </ul>
          </div>
        </Slide>
      </div>

      <div id="s2">
        <Slide n={++n} kicker="The solution" title="Short procedure videos, watched in full, with a signed certificate." tone="blue">
          <div className="deck-grid three">
            <div className="deck-card"><h3>For patients</h3><p>Plain, branded videos, a few minutes each, on any phone. They come back where they left off.</p></div>
            <div className="deck-card"><h3>For doctors</h3><p>Invite in seconds, then see progress video by video. A 12-hour reminder goes out to both sides.</p></div>
            <div className="deck-card"><h3>For insurers</h3><p>A signed certificate that every video was watched, which anyone can verify, and fewer claims from misunderstanding.</p></div>
          </div>
        </Slide>
      </div>

      <div id="s3">
        <Slide n={++n} kicker="How it works" title="Four steps from invite to certificate.">
          <ol className="deck-steps">
            <li><strong>Doctor invites.</strong> They choose the procedure and enter the patient's email; the patient gets a 48-hour link.</li>
            <li><strong>Patient confirms it's them.</strong> A one-time code by email, with no password or account.</li>
            <li><strong>Videos, in order.</strong> Each one unlocks the next. Skipping is blocked, and "still watching?" checks confirm attention.</li>
            <li><strong>Signed certificate.</strong> Issued automatically; the doctor sees it, and anyone can check it with its code.</li>
          </ol>
        </Slide>
      </div>

      <div id="s4">
        <Slide n={++n} kicker="Why it holds up" title="Built so the record stands up to scrutiny." tone="blue">
          <div className="deck-grid two">
            <ul className="deck-list">
              <li><strong>Server-paced playback:</strong> the video is released no faster than real time, so it can't be skipped, even by tampering with the browser.</li>
              <li><strong>Attention checks</strong> at undisclosed moments, and the video pauses when the patient leaves the page.</li>
              <li><strong>Identity check</strong> by one-time code to the email the doctor's office entered.</li>
            </ul>
            <ul className="deck-list">
              <li><strong>Tamper-evident audit log:</strong> every event is chained, and records can't be edited or deleted.</li>
              <li><strong>Digitally signed certificates</strong> (Ed25519) that anyone can verify at aureliuscode.com.</li>
              <li><strong>Privacy by design:</strong> links, codes and passwords are stored only in hashed form.</li>
            </ul>
          </div>
        </Slide>
      </div>

      <div id="s5">
        <Slide n={++n} kicker="Market" title="The losses are measured in billions.">
          <div className="deck-grid three">
            {[...PAYER_LOSSES, malpractice].map((r) => (
              <div key={r.name} className="deck-card">
                <p className="deck-big">{big(r.amount)}</p>
                <p><strong>{r.name}</strong><br />{r.what}, {r.year}</p>
                <p className="deck-src"><a href={r.href} target="_blank" rel="noopener noreferrer">{r.source}</a></p>
              </div>
            ))}
          </div>
          <p className="deck-note">
            Insurers' figures are all medical claims, shown for scale. Aurelius Code targets the share tied to surgery, complications
            and malpractice. These organizations are not customers.
          </p>
        </Slide>
      </div>

      <div id="s6">
        <Slide n={++n} kicker="Business model" title="Three ways to buy, from a single practice to a whole insurer." tone="blue">
          <div className="deck-grid three">
            <div className="deck-card"><h3>Subscription</h3><p>Monthly or yearly, by patient volume: private practices, small and large hospitals.</p></div>
            <div className="deck-card"><h3>Revenue share</h3><p><strong>10% of the savings</strong> we deliver to payers and insurers, measured quarterly against last year's losses. No saving, no fee.</p></div>
            <div className="deck-card"><h3>Loss prevention mandate</h3><p>Watching becomes a requirement for surgery: no certificate, no surgery. <strong>10% of malpractice savings</strong>, billed quarterly.</p></div>
          </div>
          <div className="deck-card deck-example">
            <p>
              <strong>Example:</strong> an insurer with $2 billion a year in claims losses. If losses fall 10%, it saves $50 million a
              quarter ($200 million a year), and our fee is $5 million a quarter ($20 million a year).
            </p>
          </div>
        </Slide>
      </div>

      <div id="s7">
        <Slide n={++n} kicker="Traction">
          <ul className="deck-list deck-traction">
            <li>
              <strong>The platform is live</strong> at <a href="/" target="_blank" rel="noopener">aureliuscode.com</a>:
              <ul className="deck-ticks">
                <li>Doctor portal</li>
                <li>Patient portal</li>
                <li>Completion certificate at the conclusion of each procedure's videos</li>
                <li>Public verification of every certificate</li>
              </ul>
            </li>
            <li>
              <strong>Our active videos</strong> include Brain Science and How It Works, with two procedures: Spinal Fusion and Hip
              Replacement.
            </li>
            <li><strong>Our application is tested</strong> end to end on iPhone, Android and desktop.</li>
          </ul>
        </Slide>
      </div>

      <div id="s8">
        <Slide n={++n} kicker="Team" title="Who's building it." tone="blue">
          <div className="deck-card deck-team">
            {TEAM.map((t) => <p key={t}>{t}</p>)}
          </div>
        </Slide>
      </div>

      <div id="s9">
        <Slide n={++n} kicker="Roadmap" title="Our next phase.">
          <ul className="deck-list deck-phase">
            <li>
              <strong>Coming soon: the highest-volume surgical procedures.</strong>
              <span className="deck-chips">{COMING.map((c) => <span key={c}>{c}</span>)}</span>
            </li>
            <li><strong>HIPAA-ready hosting and email</strong> under signed Business Associate Agreements (BAA), for hospital rollouts.</li>
            <li><strong>Self-serve for doctors:</strong> sign-up, billing and password reset.</li>
            <li><strong>Pilots</strong> with practices, hospital systems and an insurer, measuring the effect on claims.</li>
          </ul>
          <div className="deck-grid two deck-explain">
            <div className="deck-card">
              <h3>How a pilot works</h3>
              <p>
                A practice, hospital system or insurer uses Aurelius Code for its surgical patients for an agreed period. Before
                surgery, each patient watches their procedure's videos and receives a completion certificate.
              </p>
              <p>
                We then compare that period's claims, complaints and malpractice costs with the client's own figures from the year
                before, so the savings are measured, not assumed. Those results are the basis for sales to hospitals and health
                systems.
              </p>
            </div>
            <div className="deck-card">
              <h3>What a completion certificate is</h3>
              <p>
                When a patient finishes every video for their procedure, Aurelius Code issues a digitally signed certificate. It
                records who watched, which videos and when, and it's issued only if every minute was watched and every attention
                check was answered.
              </p>
              <p>
                The doctor keeps it with the patient's consent. Anyone, such as a hospital, insurer or court, can check its code at
                aureliuscode.com, and any change to it would show.
              </p>
            </div>
          </div>
          <p className="deck-lead">
            For more information, contact us at <a href="mailto:tony@aaurelius.com">tony@aaurelius.com</a>.
          </p>
        </Slide>
      </div>

      <div id="s10">
        <section id="demo" className="deck-slide deck-demo" aria-labelledby="demo-title">
          <div className="deck-inner">
            <p className="deck-kicker"><span>{String(++n).padStart(2, '0')}</span> Try it yourself</p>
            <h2 id="demo-title" className="deck-title">The live demo takes about five minutes.</h2>
            <ol className="deck-steps">
              <li><strong>Sign in as a doctor</strong> at <a href="/doctor" target="_blank" rel="noopener">aureliuscode.com/doctor</a> with the demo login from our email.</li>
              <li><strong>Invite yourself:</strong> click Invite patient, enter your name and email, and choose a procedure.</li>
              <li><strong>Be the patient:</strong> open the email on your phone, type the code, and watch. Try skipping ahead.</li>
              <li><strong>Watch it update:</strong> back in the doctor portal, Patients shows your progress video by video.</li>
              <li><strong>Check the certificate:</strong> after the last video, verify its code on the home page.</li>
            </ol>
            <a className="button mint" href="/doctor" target="_blank" rel="noopener">Open the doctor portal</a>
          </div>
        </section>
      </div>
    </div>
  );
}
