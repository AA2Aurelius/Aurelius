import { useEffect, useState } from 'react';
import { ApiError, formatDateTime } from '../api';
import { Link, doctorApi } from './nav';
import { linkStatus } from './status';

interface PatientRow {
  id: string;
  patient_name: string;
  procedure_name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  videos_done: number;
  videos_total: number;
  certified_at: string | null;
  hours_left: number;
}

export function Patients() {
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    doctorApi<PatientRow[]>('/patients')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load patients.'));
  }, []);

  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!rows) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => `${r.patient_name} ${r.procedure_name}`.toLowerCase().includes(q)) : rows;

  return (
    <div className="stack">
      <div className="row">
        <h1>Patients</h1>
        <Link to="/doctor/new" className="button">New prescription</Link>
      </div>

      {rows.length === 0 ? (
        <div className="card stack">
          <p>No patients yet.</p>
          <p className="muted">Prescribe a procedure's videos and the patient gets an email with their link.</p>
        </div>
      ) : (
        <>
          <label htmlFor="search" className="visually-hidden">Search patients</label>
          <input id="search" type="search" placeholder="Search by patient or procedure" value={query} onChange={(e) => setQuery(e.target.value)} />
          {shown.length === 0 && <p className="muted">No patients match “{query}”.</p>}
          <ul className="video-list">
            {shown.map((r) => {
              const status = linkStatus({ ...r, certified: !!r.certified_at });
              return (
                <li key={r.id}>
                  <Link to={`/doctor/patients/${encodeURIComponent(r.id)}`} className="video-row patient-row">
                    <div className="video-meta">
                      <span className="video-title">{r.patient_name}</span>
                      <span className="muted">{r.procedure_name} · sent {formatDateTime(r.created_at)}</span>
                    </div>
                    <div className="patient-progress">
                      <span className={`pill ${status.tone}`}>{status.label}</span>
                      <span className="muted">{r.videos_done} of {r.videos_total} videos</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
