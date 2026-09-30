import type { ReactNode } from 'react';
import { MALPRACTICE_LOSSES, PAYER_LOSSES } from './Savings';

// Headline figures, rounded: "$314 billion", "$5.0 billion".
const big = (n: number) => `$${n >= 100e9 ? Math.round(n / 1e9) : (n / 1e9).toFixed(1)} billion`;

// The investor deck as one scrolling page, at /investors. It isn't linked
// from the site's menus; it's shared by link. Edit the ASK and TEAM entries
// below before sending it.

const ASK = {
  amount: '', // e.g. '$1.5 million seed round' -- leave '' to hide the line
  uses: [] as string[], // e.g. ['Hosting and HIPAA compliance', 'Videos for 13 more procedures', 'Sales to hospital systems']
};
const TEAM: Array<{ name: string; role: string; bio: string }> = [
  { name: 'Antonius Aurelius', role: 'Founder', bio: '' },
];

const LIVE = [
  { name: 'Spinal Fusion', videos: 6 },
  { name: 'Hip Replacement', videos: 6 },
];
const COMING = [
  'Appendectomy', 'Cesarean Delivery', 'Circumcision', 'Coronary Artery Bypass Surgery', 'Gallbladder Removal',
  'Heart Valve Surgery', 'Hip Dysplasia', 'Knee Replacement', 'Laminectomy', 'Pacemakers',
  'Percutaneous Coronary Angioplasty', 'Staph Infections', 'Vaginal Hysterectomy',
];

function Slide({ n, kicker, title, children, tone }: { n: number; kicker: string; title: string; children: ReactNode; tone?: 'blue' }) {
  return (
    <section className={`deck-slide ${tone === 'blue' ? 'blue' : ''}`} aria-labelledby={`slide-${n}`}>
      <div className="deck-inner">
        <p className="deck-kicker"><span>{String(n).padStart(2, '0')}</span> {kicker}</p>
        <h2 id={`slide-${n}`} className="deck-title">{title}</h2>
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
        {['Problem', 'Solution', 'How it works', 'Why it holds up', 'Market', 'Business model', 'Traction', 'Roadmap', 'Team', 'The ask', 'Demo'].map((t, i) => (
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
        <Slide n={++n} kicker="Traction" title="Live, working, and ready for pilots.">
          <div className="deck-grid two">
            <ul className="deck-list">
              <li><strong>Platform live</strong> at aureliuscode.com: doctor portal, patient experience, certificates and public verification.</li>
              <li><strong>{LIVE.length} procedures live</strong> ({LIVE.map((p) => `${p.name}, ${p.videos} videos`).join('; ')}), plus two short explainers.</li>
              <li><strong>{COMING.length} more procedures</strong> in the pipeline.</li>
              <li>Tested end to end on iPhone, Android and desktop.</li>
            </ul>
            <div className="deck-card">
              <h3>Coming next</h3>
              <p className="deck-small">{COMING.join(' · ')}</p>
            </div>
          </div>
        </Slide>
      </div>

      <div id="s8">
        <Slide n={++n} kicker="Roadmap" title="What the next stage of funding builds." tone="blue">
          <ol className="deck-steps">
            <li><strong>HIPAA-ready hosting and email</strong> under signed business associate agreements, for hospital rollouts.</li>
            <li><strong>Videos for the procedure pipeline</strong>, starting with the highest-volume surgeries.</li>
            <li><strong>Self-serve for doctors:</strong> sign-up, billing and password reset.</li>
            <li><strong>Pilots</strong> with practices, hospital systems and an insurer, measuring the effect on claims.</li>
          </ol>
        </Slide>
      </div>

      <div id="s9">
        <Slide n={++n} kicker="Team" title="Who's building it.">
          <div className="deck-grid three">
            {TEAM.map((t) => (
              <div key={t.name} className="deck-card">
                <h3>{t.name}</h3>
                <p className="deck-role">{t.role}</p>
                {t.bio && <p>{t.bio}</p>}
              </div>
            ))}
          </div>
        </Slide>
      </div>

      <div id="s10">
        <Slide n={++n} kicker="The ask" title={ASK.amount ? `We're raising ${ASK.amount}.` : "Let's talk."} tone="blue">
          {ASK.uses.length > 0 && (
            <ul className="deck-list">
              {ASK.uses.map((u) => <li key={u}>{u}</li>)}
            </ul>
          )}
          <p className="deck-lead">
            To talk further, use the <a href="/#contact" target="_blank" rel="noopener">contact form</a> on our site.
          </p>
        </Slide>
      </div>

      <div id="s11">
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
