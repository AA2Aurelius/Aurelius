import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, api } from '../api';
import { CertificateView, type CertificateResponse } from '../components/CertificateView';
import { InviteIcon, LogoutIcon, PlayIcon, UsersIcon } from '../components/icons';
import { ExpiringAlert } from './ExpiringAlert';
import { InviteModal } from './InviteModal';
import { InviteContext } from './library';
import { Login } from './Login';
import { Link, doctorApi, navigate, setSignedOutHandler, usePath } from './nav';
import { PatientDetail } from './PatientDetail';
import { Patients } from './Patients';
import { ProcedurePage } from './ProcedurePage';
import { Videos } from './Videos';

// Fired by the header's Invite button.
export const OPEN_INVITE = 'aurelius:open-invite';

export interface Doctor { id: string; name: string; email: string }

// Everything under /doctor. Signed-out visitors see the sign-in form at any
// /doctor path and land on the page they asked for once signed in.
export function DoctorApp() {
  const path = usePath();
  const [doctor, setDoctor] = useState<Doctor | null | undefined>(undefined);
  const [notice, setNotice] = useState('');
  // A 401 only means "session ended" while signed in; after signing out,
  // requests still in flight must not replace the "signed out" message.
  const signedIn = useRef(false);
  // The Invite pop-up: undefined = closed, '' = open with no procedure chosen.
  const [inviteFor, setInviteFor] = useState<string | undefined>(undefined);
  // Bumped after an invite is sent, so the page underneath reloads its lists.
  const [refresh, setRefresh] = useState(0);
  const openInvite = useCallback((procedureId?: string) => setInviteFor(procedureId ?? ''), []);
  const closeInvite = useCallback(() => setInviteFor(undefined), []);
  const sentInvite = useCallback(() => setRefresh((n) => n + 1), []);
  useEffect(() => {
    const open = () => {
      setInviteFor('');
      if (!signedIn.current) setNotice('');
    };
    addEventListener(OPEN_INVITE, open);
    // Arriving from the home page's Invite button.
    if (new URLSearchParams(location.search).has('invite')) {
      history.replaceState(null, '', location.pathname);
      open();
    }
    return () => removeEventListener(OPEN_INVITE, open);
  }, []);
  const signIn = (d: Doctor) => {
    signedIn.current = true;
    setDoctor(d);
  };

  useEffect(() => {
    setSignedOutHandler(() => {
      if (!signedIn.current) return;
      signedIn.current = false;
      setDoctor(null);
      setNotice('Your session ended. Please sign in again.');
    });
    api<Doctor>('/api/doctor/me')
      .then(signIn)
      .catch((err) => {
        setDoctor(null);
        if (!(err instanceof ApiError && err.status === 401)) setNotice(err.message);
      });
  }, []);

  if (doctor === undefined) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  if (doctor === null) {
    // Say where signing in leads, so the header buttons visibly do something
    // before sign-in.
    const where = inviteFor !== undefined
      ? 'Sign in to invite a patient.'
      : path.startsWith('/doctor/patients')
        ? 'Sign in to see your patients.'
        : 'Sign in to see your videos.';
    return <Login notice={notice} intent={where} onSignedIn={(d) => { setNotice(''); signIn(d); }} />;
  }

  const signOut = async () => {
    signedIn.current = false;
    try {
      await doctorApi('/logout', { json: {} });
    } catch {}
    // Show sign-in before the path changes, so the patients page never loads.
    flushSync(() => {
      setDoctor(null);
      setNotice('You have signed out.');
    });
    navigate('/doctor');
  };

  const detail = /^\/doctor\/patients\/([^/]+)\/?$/.exec(path);
  const cert = /^\/doctor\/patients\/([^/]+)\/certificate\/?$/.exec(path);
  const procedure = /^\/doctor\/procedures\/([^/]+)\/?$/.exec(path);
  const onPatients = path.startsWith('/doctor/patients');
  let page;
  if (path === '/doctor/patients' || path === '/doctor/patients/') page = <Patients key={refresh} />;
  else if (procedure) page = <ProcedurePage key={`${procedure[1]}-${refresh}`} id={decodeURIComponent(procedure[1])} />;
  else if (cert) {
    const id = decodeURIComponent(cert[1]);
    page = (
      <CertificateView
        key={id}
        load={() => doctorApi<CertificateResponse>(`/prescriptions/${encodeURIComponent(id)}/certificate`)}
        backLabel="← Patient"
        onBack={() => navigate(`/doctor/patients/${encodeURIComponent(id)}`)}
      />
    );
  } else if (detail) page = <PatientDetail key={detail[1]} id={decodeURIComponent(detail[1])} />;
  else page = <Videos key={refresh} />;

  return (
    <InviteContext.Provider value={openInvite}>
      <div className="doc-layout">
        <nav className="sidebar no-print" aria-label="Doctor portal">
          <Link to="/doctor" className={`nav-item ${!onPatients ? 'active' : ''}`}><PlayIcon /> Videos</Link>
          <Link to="/doctor/patients" className={`nav-item ${onPatients ? 'active' : ''}`}><UsersIcon /> Patients</Link>
          <button className="nav-item nav-invite" onClick={() => openInvite()}><InviteIcon /> Invite patient</button>
          <div className="sidebar-spacer" />
          <span className="sidebar-user">{doctor.name}</span>
          <button className="nav-item" onClick={signOut}><LogoutIcon /> Sign out</button>
          <div className="help-card">
            <strong>NEED HELP?</strong>
            <p>A patient can't open their link? Open them under Patients and choose Send a new link.</p>
          </div>
        </nav>
        <div className="doc-main stack-lg">
          <ExpiringAlert refresh={refresh} />
          {page}
        </div>
      </div>
      {inviteFor !== undefined && (
        <InviteModal initialProcedureId={inviteFor || undefined} onClose={closeInvite} onSent={sentInvite} />
      )}
    </InviteContext.Provider>
  );
}
