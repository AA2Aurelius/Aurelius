import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, api } from '../api';
import { CertificateView, type CertificateResponse } from '../components/CertificateView';
import { Login } from './Login';
import { Link, doctorApi, navigate, setSignedOutHandler, usePath } from './nav';
import { PatientDetail } from './PatientDetail';
import { Patients } from './Patients';
import { Prescribe } from './Prescribe';
import { Videos } from './Videos';

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
    return <Login notice={notice} onSignedIn={(d) => { setNotice(''); signIn(d); }} />;
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
  let page;
  if (path === '/doctor/new') page = <Prescribe />;
  else if (path === '/doctor/videos') page = <Videos />;
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
  else page = <Patients />;

  const tab = (to: string, label: string, active: boolean) => (
    <Link to={to} className={`tab ${active ? 'active' : ''}`}>{label}</Link>
  );
  return (
    <div className="stack-lg">
      <nav className="doctor-nav no-print" aria-label="Doctor portal">
        <div className="tabs">
          {tab('/doctor', 'Patients', !['/doctor/new', '/doctor/videos'].includes(path))}
          {tab('/doctor/new', 'New prescription', path === '/doctor/new')}
          {tab('/doctor/videos', 'Videos', path === '/doctor/videos')}
        </div>
        <div className="signed-in">
          <span className="muted">{doctor.name}</span>
          <button className="link-button" onClick={signOut}>Sign out</button>
        </div>
      </nav>
      {page}
    </div>
  );
}
