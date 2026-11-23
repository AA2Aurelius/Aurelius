-- Invitations you send from the command line (npm run create-doctor --
-- --invite): the account is created by the person invited, who chooses their
-- own password from an emailed link, so nobody else ever handles it.

-- account_invites: invited_by may now be empty (an invitation from Aurelius
-- Code itself rather than from someone in the practice). SQLite can't drop a
-- NOT NULL constraint, so the table is rebuilt.
CREATE TABLE account_invites_new (
  id TEXT PRIMARY KEY,                  -- SHA-256 (hex) of the emailed token
  practice_id TEXT NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  invited_by TEXT REFERENCES doctors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
INSERT INTO account_invites_new SELECT id, practice_id, name, email, role, invited_by, created_at, expires_at, used_at, revoked_at FROM account_invites;
DROP TABLE account_invites;
ALTER TABLE account_invites_new RENAME TO account_invites;

-- Queued by the script; the Worker's 15-minute job turns each into an
-- account invitation and emails the link (the script has no email key).
CREATE TABLE invite_requests (
  id TEXT PRIMARY KEY,                  -- uuid
  practice_id TEXT NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  outcome TEXT                          -- 'sent', or why it wasn't
);
CREATE INDEX invite_requests_unsent ON invite_requests(sent_at, created_at);
