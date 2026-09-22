import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password';

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const h = await hashPassword('s3cret-passphrase');
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    expect(await verifyPassword('s3cret-passphrase', h)).toBe(true);
    expect(await verifyPassword('s3cret-passphrasE', h)).toBe(false);
  });

  it('accepts hashes made by scripts/create-doctor.mjs (Node crypto)', async () => {
    // Generated with Node's pbkdf2Sync, exactly as the script does.
    const fromNode = 'pbkdf2-sha256$100000$AAECAwQFBgcICQoLDA0ODw$TMPopZNKWfga24kHPzAkudJIy0gySXaHiUBpsB-tCYY';
    expect(await verifyPassword('longpassword123', fromNode)).toBe(true);
    expect(await verifyPassword('longpassword124', fromNode)).toBe(false);
  });

  it('rejects malformed or over-limit hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$999999$AAAA$BBBB')).toBe(false);
  });
});
