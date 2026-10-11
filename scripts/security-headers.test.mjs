import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SECURITY_HEADERS } from '../worker/security-headers.ts'

// Asset responses never reach the Worker, so public/_headers must carry the same headers.
test('public/_headers matches the headers the Worker sends', () => {
  const lines = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split(/\r?\n/)
  const rules = lines.filter((l) => /^\s+\S/.test(l)).map((l) => l.trim().split(/:\s+/))
  assert.deepEqual(Object.fromEntries(rules), SECURITY_HEADERS)
  assert.equal(lines[0], '/*')
})
