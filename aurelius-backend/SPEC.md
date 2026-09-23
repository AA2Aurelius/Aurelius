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
  links a resent prescription to the one it replaces; `0003_watch_time.sql`
  adds chunked videos, playback sessions, chunk-serve and heartbeat
  evidence, and attention checks): doctors + doctor_sessions,
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
- `POST /api/watch/:token/otp/send` — `{turnstileToken}` (Cloudflare
  Turnstile widget result); `POST /api/watch/:token/otp/verify`
- `POST /api/watch/:token/video/:videoId/playback` — start watching, or
  resume the unfinished playback. Returns `playbackId`, `playlist`
  (relative URL), `nextSeq`, `heartbeatIntervalMs`.
- `GET /api/watch/:token/playback/:id/playlist.m3u8` — live (`EVENT`) HLS
  playlist listing only released chunks; plus `init.mp4` and
  `seg/:n.m4s` (Range supported). An unreleased chunk is refused (403) and
  logged.
- `POST /api/watch/:token/playback/:id/heartbeat` — every 5 s:
  `{seq, position_ms, playing, visible, rate}`. The response carries the
  new `releasedThrough`, any `attentionCheck`, and `completed`.
- `POST /api/watch/:token/playback/:id/attention` — `{checkId}`
- `GET /api/watch/:token/playback/:id` — current state
- `POST /api/watch/:token/video/:videoId/seek-attempt` — the player reports
  a skip attempt it blocked (client-reported)
- `GET /api/watch/:token/certificate`

There is no "mark complete" endpoint: the server decides completion.

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
- **Server-paced playback (completion):** videos are packaged into 4 s
  HLS chunks (`npm run package-video`). How far playback may get
  (`allowed_ms`) grows only with real time between heartbeats, and only
  while the player reports playing, the tab is visible and no attention
  check is open. A gap between heartbeats earns at most 15 s, and
  allowed_ms can't run more than 4 s past the reported position. The
  playlist lists only chunks starting within 12 s of allowed_ms, so the
  player can't seek ahead, and a request for a later chunk is refused and
  logged as `seek_blocked`. Pausing, backgrounding or stalling can't bank
  time. Each video gets 1 attention check (under 60 s) or 2 (one per
  half, within 10–90%), at moments not revealed in advance. Playback stops
  until "I'm still watching" is tapped within 60 s; a missed check is
  logged and asked again. The server marks the video complete on its own
  once allowed_ms reaches the end, every chunk has been served, every
  check is passed, and the player reports reaching the end. That means
  real time spent at least equals the video's length. Rewatching is
  allowed and records a new playback without a second completion.
  Certificates carry `verification_level: "server-paced-v1"` and a
  per-video `watch` summary.
- **Limits of this:** a determined script that passes the email code and
  the bot check, then fetches chunks and sends heartbeats at real-time
  pace and taps the checks, would pass. The certificate therefore claims
  what the server enforced: delivery in order at no more than real time to
  a verified session, checks answered, and skip attempts blocked. Tab
  visibility and pause counts come from the browser and are labeled that
  way.
- **Bot check:** Cloudflare Turnstile must pass before a one-time code is
  emailed.
- **Certificate integrity:** each event's hash covers the previous hash,
  so the log is a chain; database triggers block UPDATE/DELETE on events
  and certificates, and on the raw playback evidence (`segment_serves`,
  `heartbeats`), whose hashes are pinned in each chained
  `playback_completed` event. The certificate pins the chain head and is
  signed with Ed25519. `/api/verify` re-checks the signature, re-walks the
  chain and recomputes the evidence hashes, so edits made even with direct
  database access show as "tampered". Verification codes are 60 random
  bits (`AUR-XXXX-XXXX-XXXX`).

## Remaining TODOs — do not skip these before going live
1. ~~Doctor authentication.~~ Done.
2. ~~Server-side watch-time verification.~~ Done (server-paced playback,
   above). Still to test on real devices, iOS Safari's built-in player in
   particular, once the frontend exists. Content questions as attention
   checks can come later.
3. **Email delivery** — done via Resend for the link, one-time codes and
   both 12h reminders. SMS is not built. Because link tokens are stored
   only as hashes, the reminder can't include the link itself; it tells
   the patient to use their original email (decided: no link encryption).
   Resend and cancel routes are done.
4. **Video upload path** for the doctor to add new procedures/videos at
   scale (dozens of procedures). Until then, `npm run package-video`
   (local ffmpeg) encodes, uploads and registers a video. An upload flow
   would need to run the same packaging off-Worker, since Workers can't run
   ffmpeg.
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
   time; verifying a second prescription replaces the first. The player
   needs hls.js (Safari/iOS can play the playlist natively), a heartbeat
   every 5 s using `document.visibilityState`, a pause while an attention
   check is open, and the Turnstile widget on the code screen.

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
npx wrangler secret put TURNSTILE_SECRET_KEY                          # from the Turnstile widget you create
npm run deploy
npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com --remote
npm run package-video -- --file hip-1.mp4 --procedure "Hip Replacement" --title "..." --order 1 --remote
```
Local development: copy `.dev.vars.example` to `.dev.vars`, then
`npm run db:migrate` and `npm run dev`. With no `RESEND_API_KEY`, emails
(including one-time codes) are printed to the console, and with no
`TURNSTILE_SECRET_KEY` the bot check is skipped (development only).
`package-video` needs ffmpeg on your PATH (or `--ffmpeg /path`).

## Reference
The reviewed/approved UI prototype (click-through, no backend) shows the
approved doctor portal layout, patient checklist/player, certificate
design, and 12h reminder banners. Match that UI when building the real
frontend against this API.
