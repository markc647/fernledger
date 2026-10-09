// Run with `npm run test:scripts`. The static half of the outbound-calls promise (ADR 0010: no one but Akahu, only if you
// use Sync, and, to check a sign-in, your own Cloudflare Access). worker/outbound.test.ts runs the routes and crons and
// watches `fetch`; this catches code paths those don't reach. The browser is held to the same promise by the CSP
// (`connect-src 'self'`, worker/security-headers.ts).
//
// Known limits. It is a line scan, a tripwire for honest mistakes, not a defence against deliberate evasion:
// - It reads only .ts and .tsx files under worker/ and src/, skipping tests and generated code. Other file types, root
//   configs, scripts/ and dependencies (node_modules, including a library that fetches on its own) are not scanned.
// - It matches call syntax: `fetch(`, `new WebSocket`, `XMLHttpRequest`, `sendBeacon`, `EventSource`, `cloudflare:sockets`.
//   An alias (`const f = fetch`), a computed name, a dynamic `import()` of a URL, or a URL set on an element from code
//   is not caught. The CSP and worker/outbound.test.ts cover some of these.
// - A line that starts with `//`, `*` or `/*` is skipped whole, even if code follows on it.
// - Only index.html is checked for external `src` and `href` (public/ files and CSS are not).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

// Ways code can reach another host. `connect(` is cloudflare:sockets, found by its import.
const OUTBOUND = [/\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bEventSource\b/, /cloudflare:sockets/]

/**
 * Source files that may make outbound calls, by path from the repo root. None yet. Akahu Sync will add its one
 * module here, and worker/outbound.test.ts must then exercise it against the Akahu host.
 */
const ALLOWED_FILES = []

/** Returns "file:line: text" for each outbound call in the source. Comment-only lines are skipped. */
export function findOutboundCalls(file, source) {
  return source
    .split(/\r?\n/)
    .flatMap((text, i) => (/^\s*(\/\/|\*|\/\*)/.test(text) || !OUTBOUND.some((re) => re.test(text)) ? [] : [`${file}:${i + 1}: ${text.trim()}`]))
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'routeTree.gen.ts' ? [path] : []
  })
}

test('no source file in worker/ or src/ makes an outbound call', () => {
  const found = ['worker', 'src'].flatMap((dir) =>
    sourceFiles(join(root, dir)).flatMap((path) => {
      const file = relative(root, path).replaceAll('\\', '/')
      return ALLOWED_FILES.includes(file) ? [] : findOutboundCalls(file, readFileSync(path, 'utf8'))
    }),
  )
  assert.deepEqual(found, [], 'ADR 0010: no one but Akahu (only if you use Sync) and your own Cloudflare Access. Akahu Sync belongs in ALLOWED_FILES, with a test in worker/outbound.test.ts.')
})

test('the finder recognises each way of calling out, and skips comments', () => {
  for (const code of ["await fetch('https://github.com')", 'fetch (url)', 'new WebSocket(url)', 'new XMLHttpRequest()', 'navigator.sendBeacon(u)', "import { connect } from 'cloudflare:sockets'"]) {
    assert.equal(findOutboundCalls('x.ts', code).length, 1, code)
  }
  assert.deepEqual(findOutboundCalls('x.ts', '// we never fetch(it) from GitHub\n * fetch(x)\nconst prefetchCount = 1'), [])
})

test('the page loads nothing from another host', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  assert.deepEqual(html.match(/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/(?!www\.w3\.org)[^"']+/gi) ?? [], [])
})
