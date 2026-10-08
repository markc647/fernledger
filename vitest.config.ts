import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: the Cloudflare plugin conflicts with Vitest's server.
// Business logic is pure functions, so plain Node is enough.
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'worker/**/*.test.ts'] },
})
