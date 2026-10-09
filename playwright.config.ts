import { defineConfig } from '@playwright/test'

// Browser tests (seam 3) run against the real dev server, whose Worker honours the localhost dev identity.
// Run with `npm run test:e2e`. They are kept out of `npm run check` because they need a browser and are slower;
// CI runs them as their own job. The first run needs `npx playwright install chromium`.
const port = 5199

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // PLAYWRIGHT_CHANNEL=msedge (or chrome) uses a browser already on your machine instead of the download.
  use: { baseURL: `http://localhost:${port}`, channel: process.env.PLAYWRIGHT_CHANNEL },
  // Every test runs in both themes; the dark project emulates a device set to dark.
  projects: [
    { name: 'light', use: { browserName: 'chromium', colorScheme: 'light' } },
    { name: 'dark', use: { browserName: 'chromium', colorScheme: 'dark' } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    // Stand-ins for .dev.vars, so CI needs no file. Made-up values.
    env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', ADMIN_EMAIL: 'admin@example.com', DEV_USER_EMAIL: 'admin@example.com' },
  },
})
