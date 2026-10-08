-- Practices with several doctors and staff, and two-step sign-in.

-- A practice groups the people who work together: everyone in it sees the
-- practice's invites. require_mfa makes two-step sign-in compulsory for
-- everyone in it.
CREATE TABLE practices (
  id TEXT PRIMARY KEY,                  -- uuid
  name TEXT NOT NULL,
  require_mfa INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Accounts (the doctors table holds every login).
--   role: 'doctor' (can be the prescribing doctor, can add people to the
--   practice) or 'staff' (sends invites on a doctor's behalf).
--   A doctor with no practice works alone, as before.
ALTER TABLE doctors ADD COLUMN practice_id TEXT REFERENCES practices(id);
ALTER TABLE doctors ADD COLUMN role TEXT NOT NULL DEFAULT 'doctor';
-- Two-step sign-in: the authenticator secret, encrypted with a key derived
-- from OTP_SECRET; the last time-step used (so a code can't be replayed);
-- and hashes of one-time recovery codes.
ALTER TABLE doctors ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE doctors ADD COLUMN totp_pending_enc TEXT;
ALTER TABLE doctors ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE doctors ADD COLUMN totp_last_step INTEGER;
ALTER TABLE doctors ADD COLUMN recovery_codes TEXT;  -- JSON array of SHA-256 hex, used ones removed
CREATE INDEX doctors_practice ON doctors(practice_id);

-- Who sent an invite (a staff member, or the doctor themselves).
ALTER TABLE prescriptions ADD COLUMN created_by TEXT REFERENCES doctors(id);
UPDATE prescriptions SET created_by = doctor_id WHERE created_by IS NULL;

-- Invitations to join a practice: an emailed link to set a password.
CREATE TABLE account_invites (
  id TEXT PRIMARY KEY,                  -- SHA-256 (hex) of the emailed token
  practice_id TEXT NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES doctors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

-- The step between a correct password and a signed-in session, for
-- accounts with two-step sign-in. id = SHA-256 of the cookie token.
CREATE TABLE mfa_challenges (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT
);
