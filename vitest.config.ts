import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: the Cloudflare Vite plugin conflicts with Vitest's server.
// Tests run inside Cloudflare's local runtime (workerd) with the bindings from wrangler.jsonc,
// including a real local D1. Access settings are test values; the Access JWKS is faked per test, never fetched.
const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['RESTORE_TARGET'], // a second, empty database for the backup round-trip test
        bindings: {
          ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
          ADMIN_EMAIL: 'Admin@example.com',
          DEV_USER_EMAIL: 'Dev@example.com', // honoured on localhost only
          TEST_MIGRATIONS: migrations, // applied to the local D1 by worker/test-setup.ts
        },
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts', 'worker/**/*.test.ts'], setupFiles: ['./worker/test-setup.ts'] },
})
