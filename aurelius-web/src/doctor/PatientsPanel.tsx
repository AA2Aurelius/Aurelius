import { formatDate } from '../api';
import { InviteIcon } from '../components/icons';
import { useInvite, type PatientRow } from './library';
import { Link } from './nav';
import { linkStatus } from './status';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

// The right-hand Patients panel: each patient with their progress and the
// hours left on their link, and an Invite button.
export function PatientsPanel({ rows, procedureId, seeAll }: { rows: PatientRow[]; procedureId?: string; seeAll?: boolean }) {
  const invite = useInvite();
  return (
    <aside className="side-panel">
      <h2>
        Patients
        {seeAll ? <Link to="/doctor/patients" className="see-all">See all</Link> : <span className="muted" style={{ fontSize: '0.8rem' }}>{rows.length}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="muted">No patients yet. Invite a patient to send them a 48-hour link to the videos.</p>
      ) : (
        <ul className="person-list">
          {rows.map((r) => {
            const status = linkStatus({ ...r, certified: !!r.certified_at });
            const stat = r.certified_at
              ? { text: '✓', cls: 'done', title: 'Complete' }
              : r.revoked_at
                ? { text: '—', cls: '', title: status.label }
                : r.hours_left <= 0
                  ? { text: 'Expired', cls: 'late', title: 'Link expired' }
                  : { text: `${Math.floor(r.hours_left)}h`, cls: r.hours_left < 12 ? 'late' : '', title: `${Math.floor(r.hours_left)} hours left` };
            return (
              <li key={r.id}>
                <Link to={`/doctor/patients/${encodeURIComponent(r.id)}`}>
                  <span className="avatar" aria-hidden="true">{initials(r.patient_name)}</span>
                  <span className="person-meta">
                    <strong>{r.patient_name}</strong>
                    <span>{procedureId ? '' : `${r.procedure_name} · `}{r.videos_done} of {r.videos_total} videos</span>
                    <span className="person-date">Invited {formatDate(r.created_at)}</span>
                  </span>
                  <span className={`person-stat ${stat.cls}`} title={stat.title}>{stat.text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <button className="invite-link" onClick={() => invite(procedureId)}>
        Invite patient <span className="icon-button" aria-hidden="true"><InviteIcon /></span>
      </button>
    </aside>
  );
}
