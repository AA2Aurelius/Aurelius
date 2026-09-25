import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrandMark } from './components/Brand';
import { DoctorApp } from './doctor/DoctorApp';
import { Home } from './pages/Home';
import { VerifyPage } from './pages/VerifyPage';
import { WatchApp } from './patient/WatchApp';
import './styles.css';

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
    badge = '🔒 Your videos';
  } else if (check) {
    page = <VerifyPage code={decodeURIComponent(check[1])} />;
    badge = 'Certificate check';
  } else page = <Home />;
  return (
    <>
      <header className="site-header no-print">
        <div className="site-header-inner">
          <a href="/" className="brand"><BrandMark /> <span>Aurelius <span className="brand-code">Code</span></span></a>
          {badge && <span className="header-pill">{badge}</span>}
        </div>
      </header>
      <main className={`container ${doctor ? 'wide' : ''}`}>{page}</main>
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
