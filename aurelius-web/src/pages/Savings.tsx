import { useState } from 'react';

// Published annual figures, for scale. Each is the company's (or the
// source's) own number for the latest full year; see `source`.
export interface LossRow { name: string; what: string; year: string; amount: number; source: string; href: string }

export const PAYER_LOSSES: LossRow[] = [
  {
    name: 'Blue Cross Blue Shield companies', what: 'Claims paid, all 33 companies', year: 'per year', amount: 600e9,
    source: "Becker's Payer Issues", href: 'https://www.beckerspayer.com/payer/100-things-to-know-about-blue-cross-blue-shield/',
  },
  {
    name: 'UnitedHealth Group', what: 'Medical costs', year: '2025', amount: 313_995e6,
    source: 'UnitedHealth Group 2025 results', href: 'https://www.unitedhealthgroup.com/content/dam/UHG/PDF/investors/2025/unh-reports-2025-results-and-issues-2026-outlook.pdf',
  },
  {
    name: 'Elevance Health (largest Blue Cross plan)', what: 'Benefit expense', year: '2025', amount: 148_223e6,
    source: 'Elevance Health 2025 results', href: 'https://www.elevancehealth.com/content/dam/elevance-health/documents/earnings/4Q2025ELVEarningsRelease.pdf',
  },
  {
    name: 'Aflac', what: 'Total benefits and claims', year: '2025', amount: 7_293e6,
    source: 'Aflac 2025 Form 10-K', href: 'https://www.sec.gov/Archives/edgar/data/4977/000162828026011402/afl-20251231.htm',
  },
];

export const MALPRACTICE_LOSSES: LossRow[] = [
  {
    name: 'All U.S. medical malpractice payments', what: '11,451 payments, about $439,000 each', year: '2024', amount: 5.02e9,
    source: 'National Practitioner Data Bank, as reported by Miller & Zois', href: 'https://www.millerandzois.com/medical-malpractice/medical-malpractice-statistics/',
  },
];

const RATES = [0.005, 0.01, 0.02, 0.05];
const FEE = 0.1;

export function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 100e9 ? 0 : 1)} billion`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 100e6 ? 0 : 1)} million`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)},000`;
  return `$${Math.round(n)}`;
}

const pct = (r: number) => `${(r * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

// Annual losses next to what an illustrative cut in them would save, and
// our 10% of that saving.
export function SavingsTable({ rows, lossLabel, caption }: { rows: LossRow[]; lossLabel: string; caption: string }) {
  const [rate, setRate] = useState(0.01);
  return (
    <div className="savings">
      <div className="savings-head">
        <p className="savings-caption">{caption}</p>
        <div className="toggle dark" role="group" aria-label="If our service reduced these losses by">
          <span className="toggle-label">If losses fall by</span>
          {RATES.map((r) => (
            <button key={r} aria-pressed={rate === r} className={rate === r ? 'on' : ''} onClick={() => setRate(r)}>{pct(r)}</button>
          ))}
        </div>
      </div>
      <div className="savings-wrap">
        <table className="savings-table">
          <thead>
            <tr><th>Who</th><th>{lossLabel}</th><th>Saved at {pct(rate)}</th><th>Our 10% fee</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                  <span>{r.what}, {r.year} · <a href={r.href} target="_blank" rel="noopener noreferrer">{r.source}</a></span>
                </td>
                <td className="amt" data-label={lossLabel}>{money(r.amount)}</td>
                <td className="amt save" data-label={`Saved at ${pct(rate)}`}>{money(r.amount * rate)}</td>
                <td className="amt fee" data-label="Our 10% fee">{money(r.amount * rate * FEE)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="savings-note">
        Published figures, shown for scale only. These organizations are not Aurelius Code customers, and the reduction is an
        illustration, not a promise: real savings are measured for each client as below.
      </p>
    </div>
  );
}

// How the fee is worked out, with a worked example.
export function FeeMethod({ kind }: { kind: 'claims' | 'malpractice' }) {
  const what = kind === 'claims' ? 'claims losses' : 'malpractice losses';
  return (
    <div className="fee-method">
      <h4>How we determine our fee</h4>
      <ol>
        <li><strong>Baseline.</strong> We take your {what} for the last full year and divide by four for a quarterly baseline.</li>
        <li><strong>Each quarter.</strong> We compare that quarter's actual {what} with the baseline. The difference is the saving you realized with Aurelius Code.</li>
        <li><strong>Our fee.</strong> 10% of that quarter's saving, billed quarterly. If there's no saving, there's no fee.</li>
      </ol>
      <p className="fee-example">
        <strong>Example:</strong> last year's {what} were $40 million, so the quarterly baseline is $10 million. This quarter
        they were $9.2 million: a saving of $800,000, and our fee is $80,000.
      </p>
    </div>
  );
}
