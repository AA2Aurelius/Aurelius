// Generates the Ed25519 key that signs certificates.
//
//   npm run gen-signing-key | npx wrangler secret put SIGNING_KEY_JWK
//
// The private key goes only to Wrangler's secret store (and .dev.vars for
// local development). To keep an offline backup, write it to a file first:
//
//   npm run -s gen-signing-key > aurelius-signing-key.json
//   npx wrangler secret put SIGNING_KEY_JWK < aurelius-signing-key.json
//
// then store the file somewhere safe and delete it from the computer.
// Replacing the key is safe: every key's public half is kept in the
// signing_keys table, so earlier certificates still verify (SPEC.md).
import { webcrypto } from 'node:crypto';
import { createHash } from 'node:crypto';

const { privateKey } = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const { kty, crv, x, d } = await webcrypto.subtle.exportKey('jwk', privateKey);
const keyId = createHash('sha256').update(x).digest('hex').slice(0, 16);

process.stderr.write(`Generated Ed25519 signing key, key_id ${keyId}\n`);
process.stdout.write(JSON.stringify({ kty, crv, x, d }));
