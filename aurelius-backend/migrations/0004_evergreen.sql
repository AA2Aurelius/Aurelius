-- Evergreen explainer videos ("Brain Science", "How It Works"): shown at the
-- top of both portals, not part of any procedure's set, never prescribed
-- and not on certificates.
--
-- They get their own tables rather than a nullable videos.procedure_id:
-- a video in a consent set and an explainer can't be mixed up by any query,
-- and D1 can't rebuild videos in place (it enforces foreign keys, so other
-- tables' references would follow a rename).

CREATE TABLE evergreen_videos (
  id TEXT PRIMARY KEY,                  -- uuid
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL UNIQUE,  -- display order in the portals
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  hls_init_r2_key TEXT NOT NULL,        -- fMP4 init segment (EXT-X-MAP)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Same layout as video_segments: 4 s chunks, in order.
CREATE TABLE evergreen_segments (
  video_id TEXT NOT NULL REFERENCES evergreen_videos(id),
  idx INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  PRIMARY KEY (video_id, idx)
);
