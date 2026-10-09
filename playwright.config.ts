import { defineConfig } from '@playwright/test'

// Browser tests (seam 3) run against the production build. The Worker still honours the localhost dev identity,
// which these tests select with a cookie (the dev-only switcher bar is not in a production build).
// Run with `npm run test:e2e`. They are kept out of `npm run check` because they need a browser and are slower;
// CI runs them as their own job. The first run needs `npx playwright install chromium`.
const port = Number(process.env.E2E_PORT ?? 5199) // E2E_PORT lets parallel checkouts each run their own server
const baseURL = `http://localhost:${port}` // the one place the port is used; the specs get it from Playwright

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // PLAYWRIGHT_CHANNEL=msedge (or chrome) uses a browser already on your machine instead of the download.
  use: { baseURL, channel: process.env.PLAYWRIGHT_CHANNEL },
  // Every test runs in both themes; the dark project emulates a device set to dark.
  projects: [
    { name: 'light', use: { browserName: 'chromium', colorScheme: 'light' } },
    { name: 'dark', use: { browserName: 'chromium', colorScheme: 'dark' } },
  ],
  webServer: {
    // The production build, served by the Worker runtime with the real headers (public/_headers and worker/security-headers.ts).
    command: `node scripts/e2e-prepare.mjs && npm run build && npx vite preview --port ${port} --strictPort`,
    timeout: 180_000,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Stand-ins for .dev.vars, so CI needs no file. Made-up values.
    // E2E_PERSIST_TO is a fresh local database of its own, migrated by scripts/e2e-prepare.mjs and read by vite.config.ts.
    env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', ADMIN_EMAIL: 'admin@example.com', DEV_USER_EMAIL: 'admin@example.com', E2E_PERSIST_TO: '.wrangler/e2e-state' },
  },
})
