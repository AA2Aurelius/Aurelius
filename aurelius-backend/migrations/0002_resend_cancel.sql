-- Resend and cancel for prescription links.
--   * Resend: a new prescription row (new token, fresh 48h, fresh progress)
--     that points back at the one it replaces; the old link is revoked.
--   * Cancel: the doctor revokes the link; revoked_reason says why.

ALTER TABLE prescriptions ADD COLUMN replaces_prescription_id TEXT REFERENCES prescriptions(id);
ALTER TABLE prescriptions ADD COLUMN revoked_reason TEXT;   -- 'cancelled' | 'resent'

-- A prescription can be replaced at most once, so resends form a single
-- line rather than branching into several live links.
CREATE UNIQUE INDEX idx_prescriptions_replaces ON prescriptions(replaces_prescription_id)
  WHERE replaces_prescription_id IS NOT NULL;
