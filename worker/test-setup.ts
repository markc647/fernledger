import type { D1Migration } from '@cloudflare/vitest-plugin'
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Every test file starts with the real schema; the migrations are read in vitest.config.ts.
const testEnv = env as unknown as { TEST_MIGRATIONS: D1Migration[]; RESTORE_TARGET: D1Database }
await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS)
// An empty twin database for the backup round-trip test (worker/backup.test.ts).
await applyD1Migrations(testEnv.RESTORE_TARGET, testEnv.TEST_MIGRATIONS)
