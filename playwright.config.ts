import { defineConfig } from '@playwright/test'

// Browser tests (seam 3) run against the production build. The Worker still honours the localhost dev identity,
// which these tests select with a cookie (the dev-only switcher bar is not in a production build).
// Run with `npm run test:e2e`. They are kept out of `npm run check` because they need a browser and are slower;
// CI runs them as their own job. The first run needs `npx playwright install chromium`.
// The server step also applies the local migrations (`npm run seed`), because the header reads the app title from D1.
const port = 5199

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // One at a time: the local D1 database is shared, and tests that change Settings must not overlap.
  workers: 1,
  // PLAYWRIGHT_CHANNEL=msedge (or chrome) uses a browser already on your machine instead of the download.
  use: { baseURL: `http://localhost:${port}`, channel: process.env.PLAYWRIGHT_CHANNEL },
  // Every test runs in both themes; the dark project emulates a device set to dark.
  projects: [
    { name: 'light', use: { browserName: 'chromium', colorScheme: 'light' } },
    { name: 'dark', use: { browserName: 'chromium', colorScheme: 'dark' } },
  ],
  webServer: {
    // The production build, served by the Worker runtime with the real headers (public/_headers and worker/security-headers.ts).
    // The seed script applies the migrations to the local D1 (so the app has its tables) and loads the made-up data.
    command: `npm run build && npm run seed && npx vite preview --port ${port} --strictPort`,
    timeout: 180_000,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    // Stand-ins for .dev.vars, so CI needs no file. Made-up values.
    env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', ADMIN_EMAIL: 'admin@example.com', DEV_USER_EMAIL: 'admin@example.com' },
  },
})
