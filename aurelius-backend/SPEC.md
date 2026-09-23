# Aurelius — Patient Consent Video Platform — Build Spec

## What this is
A loss-prevention / informed-consent tool. A doctor prescribes a set of
procedure videos (typically 6) to a patient. The patient watches them
in order, cannot skip ahead, and receives a completion certificate once
all 6 are done — timestamped proof they were shown the information.
No billing, no subscriptions.

## Confirmed requirements
1. **No billing.** Cut entirely from scope.
2. **Doctor prescribes videos.** Library must scale to dozens of surgical
   procedures, not just the initial 14 videos (Spinal Fusion, Hip
   Replacement). ~6 videos per procedure.
3. **Sequential, no-skip playback.** Patient cannot fast-forward or scrub
   ahead. Completion must be verified **server-side** — a client-only
   "no fast-forward" is not legally defensible (undermines the whole
   point of the tool) and is trivially defeated via browser dev tools.
4. **Green checkmark** appears per video once server-confirmed complete.
5. **Completion certificate**: patient name, date/time completed,
   procedure name, videos watched, seek-attempt count, verification
   code. Only generated once all videos in the set are done.
6. **48-hour link expiration** per patient/procedure prescription.
   Expired links must be resent (new link/token), not reactivated.
7. **12-hour-remaining reminder**, sent to both doctor and patient.
8. **Doctor tracking**: doctor can see each patient's per-video progress
   at any time. **Patients must never be able to see the doctor portal.**
9. **Two evergreen explainer videos** — "Brain Science" and "How It
   Works" — shown at the top of *both* the doctor and patient portals.
10. Video storage: **Cloudflare R2**. API/compute: **Cloudflare Workers**.
    Database: **Cloudflare D1**. (User's existing hosting preference —
    already tried Wrangler CLI, prefers the least-friction deploy path.)

## What's built
- `migrations/` — D1 schema (`0001_initial.sql`; `0002_resend_cancel.sql`
  links a resent prescription to the one it replaces): doctors + doctor_sessions,
  procedures, videos, prescriptions (the 48h link, stored as a hash),
  patient_otps + patient_sessions (one-time-code identity check),
  video_progress (per-video completion + seek/pause counters),
  progress_events (hash-chained, append-only audit log), certificates
  (signed, immutable), rate_limits. All timestamps are ISO-8601 UTC with
  milliseconds.
- `src/` — Hono Worker. The API lives under `/api` on the same origin as
  the frontend (`APP_ORIGIN`), so frontend pages like `/watch/{token}`
  don't collide with it.
- `wrangler.toml` — D1 + R2 bindings, cron trigger every 15 min for the
  reminder sweep.
- `test/` — vitest suite running in the Workers runtime against local D1
  and R2 (`npm test`).

### Routes
Doctor (session cookie required, except login):
- `POST /api/doctor/login`, `POST /api/doctor/logout`, `GET /api/doctor/me`
- `GET /api/doctor/procedures`
- `GET /api/doctor/patients` — the signed-in doctor's patients only
- `GET /api/doctor/prescriptions/:id` — per-video progress
- `GET /api/doctor/prescriptions/:id/certificate` — full certificate + integrity check
- `POST /api/doctor/prescribe` — emails the patient their link; the link is
  returned once in the response and can't be retrieved later
- `POST /api/doctor/prescriptions/:id/resend` — new link, fresh 48h and fresh
  progress; the old link and its sessions are revoked in the same
  transaction. Optional `{patient_email}` to correct the address. Allowed
  for live, expired or cancelled links; not once certified; once per link.
- `POST /api/doctor/prescriptions/:id/cancel` — revokes the link and ends
  verified sessions. Optional `{reason}` goes in the audit log. Not
  allowed once certified.

Patient (`:token` is the link; watching also needs a verified code session):
- `GET /api/watch/:token` — before verification: only where the code goes
- `POST /api/watch/:token/otp/send`, `POST /api/watch/:token/otp/verify`
- `GET|HEAD /api/watch/:token/video/:videoId/stream` — Range/206 support
- `POST /api/watch/:token/video/:videoId/event` — `{type: "play"|"pause"}`
- `POST /api/watch/:token/video/:videoId/seek-attempt`
- `POST /api/watch/:token/video/:videoId/complete`
- `GET /api/watch/:token/certificate`

Public:
- `GET /api/verify/:code` — status, procedure, date, patient initials only
- `POST /api/verify` — `{payload, signature}`: checks a certificate copy
- `GET /api/verify/public-key` — Ed25519 public key for independent checks

### Security model (summary)
- **Doctor auth:** PBKDF2-SHA256 passwords (100k iterations, the Workers
  maximum); server-side sessions in `__Host-` cookies (HttpOnly, Secure,
  SameSite=Strict), 30 min idle / 12 h absolute; lockout after 5 failed
  logins per email in 15 min; state-changing requests from another
  Origin are rejected. Accounts are created with `npm run create-doctor`.
- **Patient identity:** a 6-digit code emailed to the address the doctor
  entered (10 min expiry, 5 guesses, 60 s resend cooldown, 5 per hour).
  The certificate records this as "verified by one-time code sent to
  j***@example.com" — proof of control of that inbox.
- **Completion (interim):** the server marks a video complete only if it
  belongs to the prescription, is unlocked, was streamed by the server,
  and at least 98% of its duration has passed since the first stream.
  Early attempts are logged as `complete_rejected`. Certificates carry
  `verification_level: "interim-time-check"` until TODO 2 lands.
- **Certificate integrity:** each event's hash covers the previous hash,
  so the log is a chain; database triggers block UPDATE/DELETE on events
  and certificates. The certificate pins the chain head and is signed
  with Ed25519. `/api/verify` re-checks the signature and re-walks the
  chain, so edits made even with direct database access show as
  "tampered". Verification codes are 60 random bits (`AUR-XXXX-XXXX-XXXX`).

## Remaining TODOs — do not skip these before going live
1. ~~Doctor authentication.~~ Done.
2. **Full server-side watch-time verification.** The interim check above
   stops instant fake completions, but someone can still open the stream
   and leave the tab alone. Replace it with server-paced delivery
   (segment gating) + heartbeats + attention checks; then change
   `VERIFICATION_LEVEL`. This is still the single most important
   integrity requirement.
3. **Email delivery** — done via Resend for the link, one-time codes and
   both 12h reminders. SMS is not built. Because link tokens are stored
   only as hashes, the reminder can't include the link itself; it tells
   the patient to use their original email (decided: no link encryption).
   Resend and cancel routes are done.
4. **Video upload path** for the doctor to add new procedures/videos at
   scale (dozens of procedures) — not yet built. Needs an admin upload
   flow into R2 plus a `videos`/`procedures` row insert
   (`duration_seconds` is required).
5. **Certificate rendering** — the certificate endpoints return JSON; needs
   a printable/PDF view (the prototype's certificate design is the visual
   reference — ask for the published prototype link if needed).
6. **Brain Science / How It Works** videos aren't yet modeled — likely
   `procedure_id` nullable plus an `is_evergreen` flag, as a new migration.
7. **Signing-key rotation.** Verification uses the current key only;
   rotating it would make older certificates fail. Before rotating, keep
   old public keys available by `key_id`.
8. **Frontend** for this API (the Next.js app at the repo root is still
   the standalone demo). One browser holds one patient session at a
   time; verifying a second prescription replaces the first.

## Deploy steps
```
npm install
npx wrangler login                                  # your Cloudflare account
npx wrangler d1 create aurelius-db                  # paste the id into wrangler.toml
npx wrangler r2 bucket create aurelius-videos
# set APP_ORIGIN and EMAIL_FROM in wrangler.toml
npm run db:migrate:remote
openssl rand -base64 32 | npx wrangler secret put OTP_SECRET
npm run -s gen-signing-key | npx wrangler secret put SIGNING_KEY_JWK   # back this key up offline
npx wrangler secret put RESEND_API_KEY
npm run deploy
npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com --remote
```
Local development: copy `.dev.vars.example` to `.dev.vars`, then
`npm run db:migrate` and `npm run dev`. With no `RESEND_API_KEY`, emails
(including one-time codes) are printed to the console.

## Reference
The reviewed/approved UI prototype (click-through, no backend) shows the
approved doctor portal layout, patient checklist/player, certificate
design, and 12h reminder banners. Match that UI when building the real
frontend against this API.
