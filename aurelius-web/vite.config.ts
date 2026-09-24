import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The build lands in dist/, which the Worker in ../aurelius-backend serves
// as static assets on the same origin as the API.
//
// `npm run dev` proxies /api to `wrangler dev` on :8787. The API rejects
// state-changing requests from any origin but APP_ORIGIN, so the proxy
// presents itself as that origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', 'http://localhost:8787');
          });
        },
      },
    },
  },
  build: { sourcemap: false },
});
