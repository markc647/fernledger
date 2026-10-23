import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Browser tests (seam 3) run against the production build. The Worker still honours the localhost dev identity,
// which these tests select with a cookie (the dev-only switcher bar is not in a production build).
// Run with `npm run test:e2e`. They are kept out of `npm run check` because they need a browser and are slower;
// CI runs them as their own job. The first run needs `npx playwright install chromium`.
// Each checkout has a port of its own, from its folder, so parallel checkouts never share a server or a database. E2E_PORT overrides it:
// for two runs at once in one checkout, or to find a run's server. 20000–29999 is clear of Vite (5173), Wrangler (8787) and Windows' reserved ranges.
const checkoutPort = 20_000 + (parseInt(createHash('sha256').update(import.meta.dirname.toLowerCase()).digest('hex').slice(0, 8), 16) % 10_000)
const port = Number(process.env.E2E_PORT ?? checkoutPort)
const baseURL = `http://localhost:${port}` // the one place the port is used; the specs get it from Playwright
// The database is one folder per port, so no two servers share one. TEST_TEMP_ROOT (a RAM disk, say) takes the tests' throwaway files off the
// system disk: that database, and the temp files of the browsers and the Worker runtime. Without it the database is in the checkout's .wrangler.
const tempRoot = process.env.TEST_TEMP_ROOT
if (tempRoot) {
  const temp = join(tempRoot, 'Temp')
  mkdirSync(temp, { recursive: true })
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp
}
const state = join(tempRoot ?? '.wrangler', `e2e-state-${port}`)

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // One at a time: the local D1 database is shared, and tests that change Settings must not overlap.
  workers: 1,
  // PLAYWRIGHT_CHANNEL=msedge (or chrome) uses a browser already on your machine instead of the download.
  // A test that fails on CI is run again with a trace (test-results/, uploaded by ci.yml): `npx playwright show-trace <zip>` shows what the page did, which a log does not.
  use: { baseURL, channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'on-first-retry' },
  // Every test runs in the light project. The dark project emulates a device set to dark and runs only tests tagged `@theme`; see CODING_STANDARDS.md#tests.
  projects: [
    { name: 'light', use: { browserName: 'chromium', colorScheme: 'light' } },
    { name: 'dark', use: { browserName: 'chromium', colorScheme: 'dark' }, grep: /@theme/ },
  ],
  webServer: {
    // The production build, served by the Worker runtime with the real headers (public/_headers and worker/security-headers.ts).
    // E2E_SKIP_BUILD serves the build already in dist/: scripts/e2e-shards.mjs builds once for all its parts, which would overwrite each other's.
    command: `node scripts/e2e-prepare.mjs && ${process.env.E2E_SKIP_BUILD ? '' : 'npm run build && '}npx vite preview --port ${port} --strictPort`,
    timeout: 180_000,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Stand-ins for .dev.vars, so CI needs no file. Made-up values.
    // E2E_PERSIST_TO is a fresh local database of its own, migrated by scripts/e2e-prepare.mjs and read by vite.config.ts.
    env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', ADMIN_EMAIL: 'admin@example.com', DEV_USER_EMAIL: 'admin@example.com', E2E_PERSIST_TO: state },
  },
})
