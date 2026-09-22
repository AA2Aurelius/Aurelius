-- Aurelius: initial D1 schema.
-- Apply with: npm run db:migrate          (local)
--             npm run db:migrate:remote   (production)
--
-- Conventions:
--   * Every timestamp is ISO-8601 UTC with milliseconds, e.g.
--     2026-09-22T21:10:00.000Z. This format sorts correctly as text, so
--     timestamps can be compared directly in SQL. Application code always
--     writes timestamps explicitly; the defaults below use the same format.
--   * Secrets that act as bearer credentials (link tokens, session tokens,
--     one-time codes) are never stored in plain text -- only their hashes.

CREATE TABLE doctors (
  id TEXT PRIMARY KEY,                  -- uuid
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,          -- pbkdf2-sha256$<iterations>$<salt>$<hash>
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  disabled_at TEXT
);

-- Server-side doctor sessions. id = SHA-256 (hex) of the cookie token.
CREATE TABLE doctor_sessions (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,           -- drives the idle timeout
  expires_at TEXT NOT NULL,             -- absolute timeout
  revoked_at TEXT,
  client_ip TEXT,
  user_agent TEXT
);

CREATE TABLE procedures (
  id TEXT PRIMARY KEY,                  -- uuid
  name TEXT NOT NULL,                   -- e.g. "Spinal Fusion"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,                  -- uuid
  procedure_id TEXT NOT NULL REFERENCES procedures(id),
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL,         -- playback order within the procedure set
  r2_key TEXT NOT NULL,                 -- object key in R2 bucket
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (procedure_id, order_index)
);

-- One prescription = one patient assigned to one procedure's video set.
-- The 48h URL is /watch/{token}; only SHA-256(token) is stored, so the link
-- can't be recovered from the database. Resending = new row, old token dies.
CREATE TABLE prescriptions (
  id TEXT PRIMARY KEY,                  -- uuid
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  procedure_id TEXT NOT NULL REFERENCES procedures(id),
  patient_name TEXT NOT NULL,
  patient_email TEXT NOT NULL,          -- one-time codes are sent here
  link_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,             -- created_at + 48h
  reminder_12h_sent_at TEXT,            -- set once the 12h-remaining reminder is claimed
  revoked_at TEXT                       -- set if a doctor manually kills a link
);

-- One-time codes emailed to the patient before they can watch.
-- code_hash = HMAC-SHA256(OTP_SECRET, prescription_id || ':' || code).
CREATE TABLE patient_otps (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

-- Verified patient sessions, one per device. id = SHA-256 (hex) of the cookie token.
CREATE TABLE patient_sessions (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  otp_id TEXT NOT NULL REFERENCES patient_otps(id),
  created_at TEXT NOT NULL,             -- = the moment the one-time code was verified
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  client_ip TEXT,
  user_agent TEXT
);

-- One row per video per prescription. Source of truth for checkmarks and
-- the certificate. completed_at is only ever written by the server after
-- its own checks -- never on a client-sent "done" flag.
CREATE TABLE video_progress (
  id TEXT PRIMARY KEY,                  -- uuid
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  started_at TEXT,                      -- first time the server streamed this video
  completed_at TEXT,                    -- NULL until server-verified complete
  seek_attempts INTEGER NOT NULL DEFAULT 0,
  pause_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (prescription_id, video_id)
);

-- Tamper-evident, append-only audit log backing the certificate.
-- Each row's hash = SHA-256(prev_hash || '\n' || canonical JSON of the row),
-- forming a per-prescription hash chain starting from 64 zeros. The
-- certificate records the chain head, so any later edit is detectable.
CREATE TABLE progress_events (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  seq INTEGER NOT NULL,                 -- 1, 2, 3 ... within the prescription
  video_id TEXT,
  event_type TEXT NOT NULL,             -- see EventType in src/audit.ts
  server_time TEXT NOT NULL,
  client_ip TEXT,
  meta TEXT,                            -- canonical JSON, or NULL
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (prescription_id, seq)
);

-- Signed completion certificates. Issued once, never changed.
CREATE TABLE certificates (
  id TEXT PRIMARY KEY,                  -- uuid
  prescription_id TEXT NOT NULL UNIQUE REFERENCES prescriptions(id),
  verification_code TEXT NOT NULL UNIQUE, -- normalized: 12 Crockford base32 chars, no dashes
  payload TEXT NOT NULL,                -- canonical JSON that was signed
  signature TEXT NOT NULL,              -- Ed25519 signature over payload, base64url
  key_id TEXT NOT NULL,
  issued_at TEXT NOT NULL
);

-- Fixed-window counters for rate limiting (login, one-time codes, public verify, client events).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,        -- unix seconds, aligned to the window
  count INTEGER NOT NULL
);

-- Append-only enforcement. These stop application bugs from rewriting
-- history; someone with direct database access could drop them, which is
-- what the hash chain + signed certificate are there to detect.
CREATE TRIGGER progress_events_no_update BEFORE UPDATE ON progress_events
BEGIN SELECT RAISE(ABORT, 'progress_events is append-only'); END;
CREATE TRIGGER progress_events_no_delete BEFORE DELETE ON progress_events
BEGIN SELECT RAISE(ABORT, 'progress_events is append-only'); END;
CREATE TRIGGER certificates_no_update BEFORE UPDATE ON certificates
BEGIN SELECT RAISE(ABORT, 'certificates are immutable'); END;
CREATE TRIGGER certificates_no_delete BEFORE DELETE ON certificates
BEGIN SELECT RAISE(ABORT, 'certificates are immutable'); END;

CREATE INDEX idx_doctor_sessions_doctor ON doctor_sessions(doctor_id);
CREATE INDEX idx_prescriptions_doctor ON prescriptions(doctor_id, created_at);
CREATE INDEX idx_prescriptions_expiry ON prescriptions(expires_at) WHERE reminder_12h_sent_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_otps_prescription ON patient_otps(prescription_id, created_at);
CREATE INDEX idx_patient_sessions_prescription ON patient_sessions(prescription_id);
CREATE INDEX idx_progress_prescription ON video_progress(prescription_id);
CREATE INDEX idx_videos_procedure ON videos(procedure_id, order_index);
