# Aurelius Code

Informed-consent videos for patients, with a signed certificate that every
video was watched. Live at https://aureliuscode.com.

- `aurelius-backend/`: the API and the deploy (a Cloudflare Worker with D1
  and R2). `SPEC.md` there describes how everything works, the launch
  checklist and the deploy steps.
- `aurelius-web/`: the pages (React + Vite), served by the same Worker.

Deploy from `aurelius-backend/` with `npm run deploy` (it builds the pages
first). Run the tests with `npm test`.
