-- The public half of every key that has signed certificates, so the signing
-- key can be replaced (e.g. with one that has an offline backup) and
-- certificates signed by the earlier key still verify. Filled automatically
-- whenever the current key is used, and by the scheduled sweep.
CREATE TABLE signing_keys (
  key_id TEXT PRIMARY KEY,              -- first 16 hex of SHA-256(x)
  public_jwk TEXT NOT NULL,             -- {"kty":"OKP","crv":"Ed25519","x":...}
  first_seen_at TEXT NOT NULL
);
