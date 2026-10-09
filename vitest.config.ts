import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: the Cloudflare Vite plugin conflicts with Vitest's server.
// Tests run inside Cloudflare's local runtime (workerd) with the bindings from wrangler.jsonc,
// including a real local D1. Access settings are test values; the Access JWKS is faked per test, never fetched.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
          ADMIN_EMAIL: 'Admin@example.com',
        },
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts', 'worker/**/*.test.ts'] },
})
