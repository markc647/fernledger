// Run with `npm run test:scripts`. Guards settings in wrangler.jsonc that protect privacy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// wrangler.jsonc here only has whole-line comments, so stripping those is enough to parse it.
const config = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n'),
)

// Invocation logs record request URLs and headers, which carry the Access email and search text.
// Our own console logs (worker/log.ts) stay on.
test('Workers invocation logs are off, but console logs are on', () => {
  assert.equal(config.observability?.enabled, true)
  assert.equal(config.observability?.logs?.enabled, true)
  assert.equal(config.observability?.logs?.invocation_logs, false)
})

// worker/backup.ts starts a backup when the cron that fired is exactly this string, so the two must agree.
test('the weekly backup cron in worker/backup.ts is one of the crons in wrangler.jsonc', () => {
  const source = readFileSync(new URL('../worker/backup.ts', import.meta.url), 'utf8')
  const cron = source.match(/export const BACKUP_CRON = '([^']+)'/)?.[1]
  assert.ok(cron, 'BACKUP_CRON not found')
  assert.ok(config.triggers.crons.includes(cron))
})
