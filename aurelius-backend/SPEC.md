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
  evidence, and attention checks; `0004_evergreen.sql` adds the evergreen
  explainer videos in their own tables): doctors + doctor_sessions,
  procedures, videos, prescriptions (the 48h link, stored as a hash),
  patient_otps + patient_sessions (one-time-code identity check),
  video_progress (per-video completion + seek/pause counters),
  progress_events (hash-chained, append-only audit log), certificates
  (signed, immutable), rate_limits. All timestamps are ISO-8601 UTC with
  milliseconds.
- `src/` — Hono Worker. The API lives under `/api` on the same origin as
  the frontend (`APP_ORIGIN`), so frontend pages like `/watch/{token}`
  don't collide with it.
- `wrangler.toml` — D1 + R2 bindings, the `aureliuscode.com` route, the
  frontend's static files, and a cron trigger every 15 min for the
  reminder sweep.
- `../aurelius-web/` — the patient pages (React + Vite, built into
  `aurelius-web/dist` and served by this same Worker; see Frontend below).
- `test/` — vitest suite running in the Workers runtime against local D1
  and R2 (`npm test`).

### Routes
Doctor (session cookie required, except login):
- `POST /api/doctor/login`, `POST /api/doctor/logout`, `GET /api/doctor/me`
- `GET /api/doctor/procedures` — with video count, total length and first
  video (for its thumbnail)
- `GET /api/doctor/procedures/:id/videos` — the procedure's videos in order;
  `GET /api/doctor/preview/:videoId/playlist.m3u8` (and its chunks) plays
  one as plain VOD for a doctor's preview. Nothing is logged and no
  patient's progress is affected.
- `GET /api/doctor/patients` — the signed-in doctor's patients only,
  cancelled links included (a link replaced by a resend shows as its
  replacement)
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
- `GET /api/doctor/evergreen` — the evergreen explainer videos, in order,
  each with a `playlist` URL relative to that path; plus
  `evergreen/:videoId/playlist.m3u8`, `init.mp4` and `seg/:n.m4s`

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
- `GET /api/watch/:token/evergreen` — the same evergreen videos and playlist
  routes as the doctor's, for a verified patient

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
  Origin are rejected. Accounts are created with `npm run create-doctor`;
  `npm run create-doctor -- --reset --email … --remote` replaces a
  forgotten or exposed password in place, ends that doctor's sessions and
  clears the sign-in lockout (there is no self-service reset);
  `npm run create-doctor -- --email old@… --new-email new@… --remote`
  changes a doctor's email (their sign-in and where their reminder emails
  go), keeping the account and password.
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
- **Evergreen videos** ("Brain Science", "How It Works") live in their own
  tables (`evergreen_videos`, `evergreen_segments`), so they can never be
  part of a procedure's set, prescribed, or put on a certificate. They
  play as ordinary VOD (every chunk listed, no pacing, nothing logged) for
  signed-in doctors and verified patients only.
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
   (local ffmpeg) encodes, uploads and registers videos, one at a time or
   a batch from a CSV (see Deploy steps). An upload flow
   would need to run the same packaging off-Worker, since Workers can't run
   ffmpeg.
5. **Certificate rendering** — the patient's certificate page is laid out
   for printing ("Print or save as PDF" uses the browser's print dialog).
   A server-generated PDF is still to do, if one is wanted. The original
   prototype's design couldn't be found; the current design is a neutral
   placeholder.
6. ~~Brain Science / How It Works videos.~~ Done (evergreen tables and
   routes, above).
7. **Signing-key rotation.** Verification uses the current key only;
   rotating it would make older certificates fail. Before rotating, keep
   old public keys available by `key_id`.
8. **Frontend.** The patient pages and the doctor portal are built
   (`aurelius-web`, below), styled after the Scope of Work wireframes; the
   patient side has been tested on an iPhone. Still to do from the Scope of
   Work: doctors signing up themselves, plans and billing, and a fuller
   public landing page. Thumbnails are captured in the browser from each
   video, so iPhones (which won't load video without a tap) show a
   placeholder; poster images made at upload would fix that. The Next.js
   app at the repo root is the old standalone demo and can be removed. One browser holds one patient
   session at a time; verifying a second prescription replaces the first.

## Frontend (`aurelius-web`)
React + TypeScript, built with Vite into `aurelius-web/dist`, which the
Worker serves as static files (`[assets]` in `wrangler.toml`): requests
under `/api` reach the API, every other path gets the app. Security headers
for the pages (a strict Content-Security-Policy that allows only
Turnstile as third-party code, and `Referrer-Policy: strict-origin` so the
link token in the URL never leaks) are in `aurelius-web/public/_headers`.

Pages: `/watch/{token}` (the patient), `/doctor` (the doctor portal),
`/verify/{code}` (public certificate check), and `/` (the home page: a
blue hero, the procedure list — Spinal Fusion and Hip Replacement live,
the rest marked "Coming soon", a list kept in `pages/Home.tsx` — how it
works, and a certificate check). The header on every page except the
patient's has Invite patient / Patients / Videos buttons into the doctor
portal (`/doctor?invite=1` opens the Invite pop-up after sign-in).

Look: after the Scope of Work wireframes — a white header with the
green-and-gold AURELIUS CODE wordmark, a light page with white cards, the
site blue for the home page hero and bands, text in Palatino. The home
page has the hero, procedures, how it works, pricing (the wireframe's
prices, in `pages/Home.tsx`), founder and mission, a certificate check and
a sign-up band. Pricing has three tabs: Subscription (the wireframe's
plans, month or year), Revenue share (10% of what we save payers or
insurers) and Loss prevention mandate (watching is required for surgery;
a fee based on malpractice savings, billed quarterly). On the home page the header sits on the hero's blue.
The doctor's Patients page is the "Invites History" table: patient and
email, date, procedure, hours left, status ("Not accepted yet" until the
patient confirms the one-time code, then "Confirmed", "Complete",
"Expired" or "Cancelled"), and a bin button that cancels a live link.
`GET /api/doctor/patients` includes `patient_email` and `confirmed_at`. The doctor's
video list follows the "Video List" wireframe (Sort by / Category, each
card with its procedure tag, patient count and Invite). The patient's
page has an Info card (which doctor shared the videos, and a yellow
time-left bar); the portal response includes `doctorName` for it.

The patient flow at `/watch/{token}`:
1. **Confirm it's you** — Turnstile, then a 6-digit code emailed to the
   address the doctor entered.
2. **Portal** — the evergreen videos (optional), then the procedure's
   videos in order, each locked until the previous one is complete, with
   a check mark once the server confirms completion; time left on the link,
   with a warning under 12 hours.
3. **Player** — the video plays in the main area with the set's videos
   listed down one side. Safari plays HLS natively; other browsers load hls.js
   (light build) on demand. Controls are Play/Pause, Back 10 s and full
   screen; there's no seek bar. A heartbeat every 5 s reports position,
   playing and `document.visibilityState`. The video pauses when the page
   is hidden and waits for "Continue watching". Attention checks show as a
   dialog with a 60 s countdown; playback stays paused until answered. Any
   forward jump (keyboard, native controls) is undone and reported as a
   seek attempt. A video is marked complete only when a heartbeat response
   says so.
4. **Certificate** — once every video is complete: the details, per-video
   completion times, identity and pacing statements, and the verification
   code with its `/verify` link.

The doctor portal at `/doctor` (sign in with the account made by
`create-doctor`) has a sidebar (Videos, Patients, Invite patient, Sign out)
and an **Invite** pop-up reachable from every page: patient name and email,
and the procedure, picked from a list with thumbnails; it shows invites
sent this month.
- **Videos** (the home page) — every video, grouped by procedure (a
  procedure is one set, e.g. Spinal Fusion's 6 videos, watched in order and
  certified together), each group with its own Invite button; then the
  "Before you begin" videos. Filter buttons show one group, and the
  Patients panel (hours left on each link) sits alongside.
- **Procedure page** — a preview player for each of its videos in order,
  and a panel of the doctor's patients on it with hours left on each link.
- **Patients** — every prescription the doctor has sent, newest first,
  with a status (not started, in progress, fewer than 12 hours left,
  expired, cancelled, complete) and videos completed; searchable by
  patient or procedure.
- After an invite, the patient is emailed their link; it's also shown once
  in the pop-up, behind "Show the patient's link", with a warning, and
  shown open if the email failed.
- **Patient page** — per-video started and completed times, pauses and
  skip attempts; **Send a new link** (optionally to a corrected email; the
  old link stops working and progress starts again) and **Cancel link**
  (with an optional reason for the record). Links between a resent link
  and the one it replaced. Once every video is complete, the certificate,
  with a warning if it fails its integrity check.

A 401 from the API (30 minutes idle, 12 hours at most) returns the doctor
to the sign-in form, which keeps the page they were on.

**12-hour reminder.** When a link has less than 12 hours left and the
videos aren't all done, the reminder sweep emails the patient and the
doctor (once per link), the doctor portal shows a pulsing banner on every
page listing those patients with their progress, and the patient's page
shows a pulsing "Only N hours left" warning.

**Looks.** Doctors and patients get visibly different colors (a deep blue
header on periwinkle for doctors, teal on mint for patients), set as a
theme class on `<body>`; the certificate keeps the same design in both.

The public Turnstile site key is in `aurelius-web/.env.production`; builds
in any other mode leave it out, and the widget is skipped (as is the
server-side check in development).

## Deploy steps
```
npm install
npx wrangler login                                  # your Cloudflare account
npx wrangler d1 create aurelius-db                  # paste the id into wrangler.toml
npx wrangler r2 bucket create aurelius-videos
# APP_ORIGIN, EMAIL_FROM and the aureliuscode.com route are set in wrangler.toml
npm run db:migrate:remote
openssl rand -base64 32 | npx wrangler secret put OTP_SECRET
npm run -s gen-signing-key | npx wrangler secret put SIGNING_KEY_JWK   # back this key up offline
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY                          # from the Turnstile widget you create
npm run deploy                                      # builds aurelius-web, then deploys the Worker
npm run create-doctor -- --name "Dr. Jane Smith" --email jane@clinic.com --remote
npm run package-video -- --manifest videos.csv --remote        # all videos; see below
```
Uploading videos needs only D1 and R2 (`npm install`, `wrangler login`,
the two `create` commands and `db:migrate:remote`); the Worker can be
deployed later.

**Uploading videos.** Copy `videos.example.csv` to `videos.csv` (it's
git-ignored) and set each row's `file` to the video on your computer,
relative to the CSV or absolute. Columns: `file,procedure,title,order`;
leave `procedure` blank for an evergreen video. Then
`npm run package-video -- --manifest videos.csv --remote`. Every row is
checked (files exist, no repeated order) before anything is encoded.
Re-running is safe: videos already in D1 at the same position with the same
title are skipped, so a run that stopped partway continues where it left
off. A stopped run may leave the chunks of the video it was on in R2 with
nothing pointing at them; they're harmless. Single videos:
`--file hip-1.mp4 --procedure "Hip Replacement" --title "..." --order 1`,
or `--evergreen` in place of `--procedure`.

**Still frames (posters).** Each upload also saves one frame of the video
(30% of the way in, or `--poster-at <seconds>`) as `posters/<videoId>.jpg`
in R2 and records it in `poster_r2_key` (migration `0005`). The pages show
it on every video card and in the player before it starts. For videos
uploaded before this existed, run the same manifest with `--posters`:
`npm run package-video -- --manifest videos.csv --posters --remote` makes
and uploads only the frames. Without a frame, the pages grab one in the
browser instead.
**Prescribing from the command line.** The doctor portal is the normal
way; for scripted tests,
`npm run test-prescribe -- --doctor you@clinic.com --email patient@example.com --name "Test Patient" --procedure "Hip Replacement"`
signs in as that doctor (it asks for the password), prescribes through the
live API and prints the patient link; the patient also gets the normal
email. Add `--api http://localhost:8787` to use a local Worker.

**Local development.** Copy `.dev.vars.example` to `.dev.vars`, then
`npm run db:migrate`, `npm run build:web` and `npm run dev` (the app and
API on http://localhost:8787). With no `RESEND_API_KEY`, emails (including
one-time codes) are printed to the console, and with no
`TURNSTILE_SECRET_KEY` the bot check is skipped (development only). For
the Turnstile widget to be skipped too, build the pages in development
mode: `npm --prefix ../aurelius-web run build:dev`.
For live reloading of the pages, run `npm run dev` here and `npm run dev`
in `aurelius-web` (Vite on :5173, forwarding `/api` to :8787).
`package-video` needs ffmpeg on your PATH (or `--ffmpeg /path`).

## Reference
An approved UI prototype (click-through, no backend) existed, but its link
couldn't be found. The frontend uses a neutral design instead; its colors
and spacing are defined at the top of `aurelius-web/src/styles.css` so a
restyle is contained.
