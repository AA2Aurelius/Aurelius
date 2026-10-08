-- Where to send "a certificate is ready" notices: the practice's office
-- address, or a solo doctor's own setting.
ALTER TABLE practices ADD COLUMN certificate_email TEXT;
ALTER TABLE doctors ADD COLUMN certificate_email TEXT;
