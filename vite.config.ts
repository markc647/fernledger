import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Browser tests keep their local database apart from the one `npm run dev` uses (scripts/e2e-prepare.mjs sets this).
const persistState = process.env.E2E_PERSIST_TO ? { path: process.env.E2E_PERSIST_TO } : undefined
// Nor do they open the debugger, whose one port (9229) would stop a second server starting beside the first (scripts/e2e-shards.mjs).
const inspectorPort = process.env.E2E_PERSIST_TO ? false : undefined

export default defineConfig({
  // The router plugin must come before the React plugin.
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss(), cloudflare({ persistState, inspectorPort })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
