import { useEffect, useState } from 'react';
import type { PatientRow } from './library';
import { Link, doctorApi } from './nav';

// The 12-hour reminder inside the portal: every patient whose link has less
// than 12 hours left and who hasn't finished, shown at the top of every page
// (the same moment the reminder emails go out). Rechecked every 5 minutes.
export function ExpiringAlert({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<PatientRow[]>([]);
  useEffect(() => {
    const load = () => doctorApi<PatientRow[]>('/patients').then(setRows).catch(() => {});
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  const soon = rows.filter((r) => !r.revoked_at && !r.certified_at && r.hours_left > 0 && r.hours_left < 12);
  if (soon.length === 0) return null;
  return (
    <div className="alert-12h" role="status">
      <strong>⏰ 12-hour reminder:</strong>{' '}
      {soon.length === 1 ? '1 patient has' : `${soon.length} patients have`} less than 12 hours left to finish their videos.
      <ul>
        {soon.map((r) => (
          <li key={r.id}>
            <Link to={`/doctor/patients/${encodeURIComponent(r.id)}`}>{r.patient_name}</Link> · {r.procedure_name} ·{' '}
            {r.videos_done} of {r.videos_total} videos · {Math.max(1, Math.floor(r.hours_left))}h left
          </li>
        ))}
      </ul>
    </div>
  );
}
