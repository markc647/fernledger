import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SECURITY_HEADERS } from '../worker/security-headers.ts'

// public/_headers, as { path pattern: [[header, value] or ['!', header to detach], ...] }.
const rules = Object.groupBy(
  readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .reduce((lines, line) => {
      if (/^\S/.test(line)) lines.push({ path: line.trim(), header: [] })
      else lines.at(-1).header.push(line.trim().startsWith('!') ? ['!', line.trim().slice(1).trim()] : line.trim().split(/:\s+/))
      return lines
    }, []),
  (rule) => rule.path,
)
const headersOf = (path) => rules[path].flatMap((rule) => rule.header)

// Asset responses never reach the Worker, so public/_headers must carry the same headers.
test('public/_headers matches the headers the Worker sends', () => {
  const { 'Cache-Control': _, ...security } = Object.fromEntries(headersOf('/*'))
  assert.deepEqual(security, SECURITY_HEADERS)
  assert.equal(Object.keys(rules)[0], '/*')
})

// Cloudflare Access answers an expired session with a redirect to its sign-in page (src/lib/session.ts). A page a browser keeps, or restores on Back, never asks Access, so the
// app would sit on screen with nothing behind it. `/*` is every page, because the single-page fallback serves index.html under any address.
test('no page is stored, and only the hashed files in /assets are kept for a year', () => {
  assert.deepEqual(
    headersOf('/*').filter(([name]) => name === 'Cache-Control'),
    [['Cache-Control', 'no-store']],
  )
  // A file's name there is its content's hash, so a changed file is a new address. The detach is needed: a header from two rules is joined, not replaced.
  assert.deepEqual(headersOf('/assets/*'), [
    ['!', 'Cache-Control'],
    ['Cache-Control', 'public, max-age=31536000, immutable'],
  ])
  assert.deepEqual(Object.keys(rules), ['/*', '/assets/*'])
})
