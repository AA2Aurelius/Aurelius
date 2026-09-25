import { StrictMode, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Wordmark } from './components/Brand';
import { DoctorApp, OPEN_INVITE } from './doctor/DoctorApp';
import { navigate } from './doctor/nav';
import { Home } from './pages/Home';
import { VerifyPage } from './pages/VerifyPage';
import { WatchApp } from './patient/WatchApp';
import './styles.css';

// Buttons to the doctor's pages. Inside the portal they move without a page
// load; elsewhere they are plain links (signing in first if needed).
function TopNav({ doctor }: { doctor: boolean }) {
  const go = (to: string) => (e: MouseEvent) => {
    if (!doctor) return;
    e.preventDefault();
    navigate(to);
  };
  const invite = (e: MouseEvent) => {
    if (!doctor) return;
    e.preventDefault();
    dispatchEvent(new Event(OPEN_INVITE));
  };
  return (
    <nav className="top-nav no-print" aria-label="Site">
      <a href="/doctor?invite=1" onClick={invite}>Invite patient</a>
      <a href="/doctor/patients" onClick={go('/doctor/patients')}>Patients</a>
      <a href="/doctor" onClick={go('/doctor')}>Videos</a>
    </nav>
  );
}

// Four kinds of page; the path decides which.
function App() {
  const path = location.pathname;
  const watch = /^\/watch\/([^/]+)\/?$/.exec(path);
  const check = /^\/verify\/([^/]+)\/?$/.exec(path);
  const doctor = /^\/doctor(\/|$)/.test(path);
  let page;
  let badge = '';
  if (doctor) {
    page = <DoctorApp />;
    badge = 'Doctor portal';
  } else if (watch) {
    page = <WatchApp token={decodeURIComponent(watch[1])} />;
    badge = 'Patient portal';
  } else if (check) {
    page = <VerifyPage code={decodeURIComponent(check[1])} />;
    badge = 'Certificate check';
  } else page = <Home />;
  // Doctors and patients get visibly different colors, so it's always clear
  // which side you're looking at.
  document.body.className = doctor ? 'theme-doctor' : watch ? 'theme-patient' : 'theme-public';
  return (
    <>
      <header className="site-header no-print">
        <div className="site-header-inner">
          <a href="/" className="brand"><Wordmark /></a>
          <div className="header-right">
            {!watch && <TopNav doctor={doctor} />}
            {badge && <span className="header-pill">{badge}</span>}
          </div>
        </div>
      </header>
      <main className={!doctor && !watch && !check ? 'home-main' : `container ${doctor || watch ? 'wide' : ''}`}>{page}</main>
      <footer className="site-footer no-print">
        © {new Date().getFullYear()} Aurelius Code · Because everyone can use a little help from time to time
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
