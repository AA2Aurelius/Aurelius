import { useEffect, useState } from 'react';
import { ApiError, formatDate } from '../api';
import { InviteIcon } from '../components/icons';
import { useInvite, type PatientRow } from './library';
import { doctorApi, navigate } from './nav';

type Filter = 'all' | 'waiting' | 'confirmed' | 'complete' | 'ended';

// Where each invite stands, in the wireframe's words: the patient has
// confirmed it's them ("Confirmed"), or hasn't opened it yet.
function inviteStatus(r: PatientRow): { label: string; cls: string; group: Filter } {
  if (r.certified_at) return { label: 'Complete', cls: 'ok', group: 'complete' };
  if (r.revoked_at) return { label: r.revoked_reason === 'resent' ? 'Replaced' : 'Cancelled', cls: 'muted', group: 'ended' };
  if (r.hours_left <= 0) return { label: 'Expired', cls: 'bad', group: 'ended' };
  if (r.confirmed_at) return { label: r.videos_done ? `Confirmed · ${r.videos_done} of ${r.videos_total}` : 'Confirmed', cls: 'ok', group: 'confirmed' };
  return { label: 'Not accepted yet', cls: 'wait', group: 'waiting' };
}

// The doctor's invites history, after the "Invites History" wireframe: a
// table of every invite with its time left and status.
export function Patients() {
  const invite = useInvite();
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState('');

  const load = () =>
    doctorApi<PatientRow[]>('/patients')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load patients.'));
  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!rows) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const now = new Date();
  const thisMonth = rows.filter((r) => { const d = new Date(r.created_at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).length;
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || inviteStatus(r).group === filter) &&
      (!q || `${r.patient_name} ${r.patient_email} ${r.procedure_name}`.toLowerCase().includes(q))
  );

  const cancel = async (r: PatientRow) => {
    if (!confirm(`Cancel ${r.patient_name}'s link? It stops working right away.`)) return;
    setBusy(r.id);
    try {
      await doctorApi(`/prescriptions/${encodeURIComponent(r.id)}/cancel`, { json: {} });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not cancel the link.');
    } finally {
      setBusy('');
    }
  };
  const open = (r: PatientRow) => navigate(`/doctor/patients/${encodeURIComponent(r.id)}`);

  return (
    <div className="stack-lg">
      <h1 style={{ margin: 0 }}>Invites History</h1>
      <div className="history-tools">
        <label className="underline-search">
          <span className="sr-only">Search patients</span>
          <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search patients" />
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </label>
        <select className="filter-select" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter by">
          <option value="all">Filter by: all</option>
          <option value="waiting">Not accepted yet</option>
          <option value="confirmed">Confirmed</option>
          <option value="complete">Complete</option>
          <option value="ended">Expired or cancelled</option>
        </select>
        <div className="month-count"><strong>{thisMonth}</strong><span>invites this month</span></div>
        <button className="button" onClick={() => invite()}><InviteIcon /> Invite patient</button>
      </div>

      {rows.length === 0 ? (
        <div className="card stack">
          <p>No invites yet.</p>
          <p className="muted">Invite a patient to a procedure's videos and they get an email with their link.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted">No invites match.</p>
      ) : (
        <div className="history-wrap">
          <table className="history-table">
            <thead>
              <tr><th>#</th><th>Patient</th><th>Date</th><th>Video</th><th>Time</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const st = inviteStatus(r);
                const live = !r.revoked_at && !r.certified_at && r.hours_left > 0;
                return (
                  <tr key={r.id} onClick={() => open(r)}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <a href={`/doctor/patients/${encodeURIComponent(r.id)}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(r); }} className="h-name">{r.patient_name}</a>
                      <span className="h-email">{r.patient_email}</span>
                    </td>
                    <td>{formatDate(r.created_at)}</td>
                    <td>{r.procedure_name}</td>
                    <td className={`h-time ${live && r.hours_left < 12 ? 'late' : ''}`}>
                      {live ? `${Math.floor(r.hours_left)} h` : '—'}
                    </td>
                    <td><span className={`h-status ${st.cls}`}>{st.label}</span></td>
                    <td>
                      {live ? (
                        <button className="trash" aria-label={`Cancel ${r.patient_name}'s link`} title="Cancel link" disabled={busy === r.id} onClick={(e) => { e.stopPropagation(); cancel(r); }}>
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
