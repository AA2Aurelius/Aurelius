-- Server-paced playback: the server hands out video in ~4 s HLS chunks no
-- faster than it can be watched, and decides completion itself.
--
-- The evidence tables (segment_serves, heartbeats) are append-only; their
-- contents are hashed into the chained `playback_completed` audit event, so
-- a later edit breaks the certificate's audit-log check.

-- A video is playable only once packaged (npm run package-video).
ALTER TABLE videos ADD COLUMN hls_init_r2_key TEXT;      -- fMP4 init segment (EXT-X-MAP)

CREATE TABLE video_segments (
  video_id TEXT NOT NULL REFERENCES videos(id),
  idx INTEGER NOT NULL,                  -- 0-based, in playback order
  r2_key TEXT NOT NULL,
  start_ms INTEGER NOT NULL,             -- media time where this chunk starts
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  PRIMARY KEY (video_id, idx)
);

-- One viewing of one video. `allowed_ms` is how far into the video the
-- server has let playback get; it only grows with real elapsed time while
-- the player reports playing, visible and not blocked by an attention check.
CREATE TABLE playback_sessions (
  id TEXT PRIMARY KEY,                   -- uuid; appears in playlist/chunk URLs
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  patient_session_id TEXT NOT NULL,      -- session that started it
  created_at TEXT NOT NULL,
  total_ms INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  allowed_ms INTEGER NOT NULL DEFAULT 0,
  released_through INTEGER NOT NULL,     -- highest chunk index listed in the playlist
  last_heartbeat_seq INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  last_position_ms INTEGER NOT NULL DEFAULT 0,
  last_playing INTEGER NOT NULL DEFAULT 0, -- state from the latest heartbeat
  last_visible INTEGER NOT NULL DEFAULT 1,
  credited_ms INTEGER NOT NULL DEFAULT 0,  -- wall time counted as watching
  playing_ms INTEGER NOT NULL DEFAULT 0,   -- wall time the player said it was playing
  hidden_ms INTEGER NOT NULL DEFAULT 0,    -- ...of which the tab was hidden
  pauses INTEGER NOT NULL DEFAULT 0,
  seek_blocked INTEGER NOT NULL DEFAULT 0, -- server-detected skip attempts
  completed_at TEXT
);

-- First time each chunk was served, per playback. The core evidence.
CREATE TABLE segment_serves (
  playback_id TEXT NOT NULL REFERENCES playback_sessions(id),
  idx INTEGER NOT NULL,
  first_served_at TEXT NOT NULL,
  PRIMARY KEY (playback_id, idx)
);

-- Every accepted heartbeat, exactly as received. seq has no gaps.
CREATE TABLE heartbeats (
  playback_id TEXT NOT NULL REFERENCES playback_sessions(id),
  seq INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  playing INTEGER NOT NULL,
  visible INTEGER NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (playback_id, seq)
);

-- "Are you still watching?" checks at server-chosen, undisclosed moments.
CREATE TABLE attention_checks (
  id TEXT PRIMARY KEY,
  playback_id TEXT NOT NULL REFERENCES playback_sessions(id),
  at_ms INTEGER NOT NULL,                -- media time that triggers it
  issued_at TEXT,                        -- when first shown
  expires_at TEXT,
  answered_at TEXT,
  outcome TEXT                           -- 'passed' | 'missed' (a missed check is replaced by a new one)
);

ALTER TABLE video_progress ADD COLUMN completed_playback_id TEXT REFERENCES playback_sessions(id);

CREATE TRIGGER segment_serves_no_update BEFORE UPDATE ON segment_serves
BEGIN SELECT RAISE(ABORT, 'segment_serves is append-only'); END;
CREATE TRIGGER segment_serves_no_delete BEFORE DELETE ON segment_serves
BEGIN SELECT RAISE(ABORT, 'segment_serves is append-only'); END;
CREATE TRIGGER heartbeats_no_update BEFORE UPDATE ON heartbeats
BEGIN SELECT RAISE(ABORT, 'heartbeats is append-only'); END;
CREATE TRIGGER heartbeats_no_delete BEFORE DELETE ON heartbeats
BEGIN SELECT RAISE(ABORT, 'heartbeats is append-only'); END;

CREATE INDEX idx_playback_lookup ON playback_sessions(prescription_id, video_id, completed_at);
CREATE INDEX idx_checks_playback ON attention_checks(playback_id, at_ms);
