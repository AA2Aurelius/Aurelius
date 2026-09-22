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

## What's already built (this scaffold)
- `schema.sql` — full D1 schema: doctors, procedures, videos,
  prescriptions (the 48h link), video_progress (per-video completion +
  seek/pause counters), progress_events (append-only audit log backing
  the certificate).
- `src/index.ts` — Hono-based Worker with routes for: doctor procedure
  library, doctor patient-tracking list, prescribe-to-patient, patient
  watch view, video streaming from R2, seek-attempt logging, video
  completion, certificate generation, and a cron-driven 12h reminder
  sweep.
- `wrangler.toml` — D1 + R2 bindings, cron trigger every 15 min for the
  reminder sweep.

## Explicitly left as TODOs — do not skip these before going live
1. **Doctor authentication.** Every `/doctor/*` route is currently
   unauthenticated (reads a trusted `X-Doctor-Id` header as a stub).
   Needs real session auth (signed cookie or JWT) before any real
   patient data touches this.
2. **Server-side watch-time verification.** `/complete` currently trusts
   the client's call. Before shipping, tie completion to server-observed
   playback — e.g. track byte-range requests against video duration, or
   require periodic server-side heartbeat checks the client can't skip.
   This is the single most important integrity requirement in the whole
   app — it's what makes the certificate legally meaningful.
3. **Actual email/SMS delivery** for: the initial 48h link, and the 12h
   reminder to both doctor and patient. Stubbed as TODO comments;
   needs a provider (e.g. Resend, Postmark, Twilio) and API key as a
   Wrangler secret.
4. **Video upload path** for the doctor to add new procedures/videos at
   scale (dozens of procedures) — not yet built. Needs an admin upload
   flow into R2 plus a `videos`/`procedures` row insert.
5. **Certificate rendering** — the `/certificate` endpoint returns JSON
   data; needs a printable/PDF view (the prototype's certificate design
   is the visual reference — ask for the published prototype link if
   needed).
6. **Brain Science / How It Works** videos aren't yet modeled — likely
   just two more rows in `videos` with a `procedure_id` of NULL and a
   dedicated "evergreen" flag, or a separate small table.

## Deploy steps (once code is ready)
```
npm install
wrangler login                      # user's own Cloudflare account
wrangler d1 create aurelius-db      # paste resulting id into wrangler.toml
wrangler r2 bucket create aurelius-videos
npm run db:init:remote
wrangler secret put JWT_SECRET
wrangler secret put RESEND_API_KEY
npm run deploy
```

## Reference
The reviewed/approved UI prototype (click-through, no backend) shows the
approved doctor portal layout, patient checklist/player, certificate
design, and 12h reminder banners. Match that UI when building the real
frontend against this API.
