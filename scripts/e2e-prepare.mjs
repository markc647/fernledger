// Run by Playwright before it starts the app: gives the browser tests a fresh local database with every migration
// applied, in their own folder so `npm run dev`'s data is never touched. Local only: every command passes --local.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const state = process.env.E2E_PERSIST_TO
if (!state) throw new Error('E2E_PERSIST_TO is not set; run this through Playwright (playwright.config.ts).')

rmSync(resolve(root, state), { recursive: true, force: true })
const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const result = spawnSync(process.execPath, [bin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
