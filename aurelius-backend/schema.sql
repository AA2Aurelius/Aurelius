-- Aurelius: Cloudflare D1 schema
-- Run with: wrangler d1 execute aurelius-db --file=./schema.sql

CREATE TABLE doctors (
  id TEXT PRIMARY KEY,              -- uuid
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE procedures (
  id TEXT PRIMARY KEY,              -- uuid
  name TEXT NOT NULL,               -- e.g. "Spinal Fusion"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,              -- uuid
  procedure_id TEXT NOT NULL REFERENCES procedures(id),
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL,     -- 1-6, playback order within the procedure set
  r2_key TEXT NOT NULL,             -- object key in R2 bucket
  duration_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One prescription = one patient assigned to one procedure's video set.
-- The link token is what the 48h URL is built from: /watch/{token}
CREATE TABLE prescriptions (
  id TEXT PRIMARY KEY,              -- uuid
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  procedure_id TEXT NOT NULL REFERENCES procedures(id),
  patient_name TEXT NOT NULL,
  patient_email TEXT,
  link_token TEXT UNIQUE NOT NULL,  -- random, unguessable (32+ bytes, base64url)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,         -- created_at + 48h; resend = new row, old token dies
  reminder_12h_sent_at TEXT,        -- set once the 12h-remaining reminder fires
  revoked_at TEXT                   -- set if a doctor manually kills a link
);

-- One row per video per prescription. This is the source of truth for
-- checkmarks, the certificate, and the malpractice-defense audit trail.
-- Completion is only ever written by the server after it verifies the
-- video was watched start-to-finish -- never trust a client-sent "done" flag.
CREATE TABLE video_progress (
  id TEXT PRIMARY KEY,              -- uuid
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  started_at TEXT,
  completed_at TEXT,                -- NULL until server-verified complete
  seek_attempts INTEGER NOT NULL DEFAULT 0,
  pause_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(prescription_id, video_id)
);

-- Immutable log backing the certificate + any future dispute. Never update
-- or delete rows here -- append only.
CREATE TABLE progress_events (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  video_id TEXT,
  event_type TEXT NOT NULL,         -- 'play' | 'pause' | 'seek_attempt' | 'complete' | 'link_sent' | 'link_resent' | 'reminder_12h'
  server_time TEXT NOT NULL DEFAULT (datetime('now')),
  client_ip TEXT,
  meta TEXT                          -- json blob for anything extra
);

CREATE INDEX idx_prescriptions_token ON prescriptions(link_token);
CREATE INDEX idx_progress_prescription ON video_progress(prescription_id);
CREATE INDEX idx_events_prescription ON progress_events(prescription_id);
