import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { webcrypto } from 'node:crypto';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  // A throwaway signing key for the test run.
  const { privateKey } = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            APP_ORIGIN: 'https://app.test',
            EMAIL_FROM: 'Aurelius <no-reply@app.test>',
            OTP_SECRET: 'test-otp-secret',
            SIGNING_KEY_JWK: JSON.stringify(jwk),
            RESEND_API_KEY: 'test-resend-key',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
