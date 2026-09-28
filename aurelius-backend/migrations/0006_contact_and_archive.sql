-- Messages from the home page's contact form ("Contact us", "Sign up").
-- Kept here as well as emailed, so none is lost if email fails.
CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,                  -- uuid
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  organization TEXT,
  topic TEXT,
  message TEXT NOT NULL,
  client_ip TEXT,
  emailed_at TEXT                       -- when it was forwarded to CONTACT_TO
);

-- Hides an invite from the doctor's lists (e.g. test invites before
-- launch). The audit trail and any certificate are untouched and stay
-- verifiable; progress_events and certificates can't be deleted anyway.
ALTER TABLE prescriptions ADD COLUMN archived_at TEXT;
