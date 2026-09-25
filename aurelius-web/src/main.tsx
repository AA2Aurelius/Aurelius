import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
  let page;
  if (/^\/doctor(\/|$)/.test(path)) page = <DoctorApp />;
  else if (watch) page = <WatchApp token={decodeURIComponent(watch[1])} />;
  else if (check) page = <VerifyPage code={decodeURIComponent(check[1])} />;
  else page = <Home />;
  return (
    <>
      <header className="site-header no-print">
        <a href="/" className="brand">Aurelius</a>
      </header>
      <main className="container">{page}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
