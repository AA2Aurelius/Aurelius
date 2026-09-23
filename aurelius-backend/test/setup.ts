import { applyD1Migrations } from 'cloudflare:test';
import { vi } from 'vitest';
import { env } from './helpers';

// Every test runs on a controlled clock: time stands still unless a test
// moves it with advance(). That's how pacing is tested for real rather than
// by editing timestamps in the database.
vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
