import type { D1Migration } from '@cloudflare/vitest-plugin'
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Every test file starts with the real schema; the migrations are read in vitest.config.ts.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS)
