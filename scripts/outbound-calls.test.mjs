// Run with `npm run test:scripts`. The static half of the outbound-calls promise (ADR 0010: no one but Akahu, only if you
// use Sync, and your own Cloudflare account: its Access, to check a sign-in, and, only if you set a token for it, its D1 usage
// figures). worker/outbound.test.ts runs the routes and crons and watches `fetch`; this catches code paths those don't reach. The browser is held to the same promise by the CSP
// (`connect-src 'self'`, worker/security-headers.ts).
//
// Known limits. It is a line scan, a tripwire for honest mistakes, not a defence against deliberate evasion:
// - It reads only .ts and .tsx files under worker/ and src/, skipping tests and generated code. Other file types, root
//   configs, scripts/ and dependencies (node_modules, including a library that fetches on its own) are not scanned.
// - It matches call syntax: `fetch(`, `new WebSocket`, `XMLHttpRequest`, `sendBeacon`, `EventSource`, `cloudflare:sockets`.
//   An alias (`const f = fetch`), a computed name, a dynamic `import()` of a URL, or a URL set on an element from code
//   is not caught. The CSP and worker/outbound.test.ts cover some of these.
// - A line that starts with `//`, `*` or `/*` is skipped whole, even if code follows on it.
// - src/lib/session.ts passes the browser's `fetch` by name to the API client (`inner = fetch`), so that a redirect is not followed: an alias, which is not caught (above), and so
//   the one use of it that is known and let be (it names no address; ADR 0010, Consequences). A second would not be found either.
// - Only index.html is checked for external `src` and `href` (public/ files and CSS are not).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

// Ways code can reach another host. `connect(` is cloudflare:sockets, found by its import.
const OUTBOUND = [/\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bEventSource\b/, /cloudflare:sockets/]

/**
 * Source files that may make an outbound call, by path from the repo root, each with the one address it may call and the name of
 * the constant that holds it. A file here is not let off: `checkAllowedFile` holds it to exactly one call, to that constant, and to
 * that address as the only one it names.
 * - worker/d1-usage.ts: the D1 usage bar asks Cloudflare's GraphQL Analytics API for the Deployer's own account usage, and only when
 *   CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID are set (ADR 0010, amended 2026-10-14). worker/outbound.test.ts reaches it with both set.
 * - worker/akahu.ts: Akahu, the one third party, and only when both Akahu tokens are set (ADR 0008, ADR 0010). It is a REST API
 *   reached by path, so its call is a template literal beginning with the constant. worker/outbound.test.ts reaches it with both
 *   tokens set, from the Admin's route for listing Akahu accounts and from the Sync cron.
 */
const ALLOWED_FILES = {
  'worker/d1-usage.ts': { url: 'https://api.cloudflare.com/client/v4/graphql', urlName: 'GRAPHQL_URL' },
  'worker/akahu.ts': { url: 'https://api.akahu.io/v1', urlName: 'AKAHU_API' },
}

/** Returns "file:line: text" for each outbound call in the source. Comment-only lines are skipped. */
export function findOutboundCalls(file, source) {
  return source
    .split(/\r?\n/)
    .flatMap((text, i) => (/^\s*(\/\/|\*|\/\*)/.test(text) || !OUTBOUND.some((re) => re.test(text)) ? [] : [`${file}:${i + 1}: ${text.trim()}`]))
}

const URL_LITERAL = /https?:\/\/[^\s'"`)\\]+/g

/**
 * What is wrong with a file that is allowed to call out, as problems to print (none if it is as allowed): it makes exactly one call,
 * that call is `fetch(<urlName>, ...)`, `<urlName>` is the allowed address, and no other address is named in the file's code.
 */
export function checkAllowedFile(file, source, { url, urlName }) {
  const code = source.split(/\r?\n/).filter((text) => !/^\s*(\/\/|\*|\/\*)/.test(text))
  const calls = findOutboundCalls(file, source)
  const problems = []
  if (calls.length !== 1) problems.push(`${file}: it may make exactly one outbound call, and makes ${calls.length}`)
  // The constant alone, or a template literal that begins with it (an API reached by path). Appending a path cannot change the
  // host: a literal address anywhere in the file is caught below, so there is nothing to build another one out of.
  else if (!new RegExp(String.raw`\bfetch\((?:${urlName}[,)]|\x60\$\{${urlName}\})`).test(calls[0])) problems.push(`${file}: its one call must be fetch(${urlName}, ...): ${calls[0]}`)
  if (!code.some((text) => text.includes(`const ${urlName} = '${url}'`))) problems.push(`${file}: ${urlName} must be '${url}'`)
  const named = [...new Set(code.flatMap((text) => text.match(URL_LITERAL) ?? []))].filter((name) => name !== url)
  if (named.length > 0) problems.push(`${file}: it may name no address but ${url}, and names ${named.join(', ')}`)
  return problems
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'routeTree.gen.ts' ? [path] : []
  })
}

test('no source file in worker/ or src/ makes an outbound call, but the one allowed to, to its one address', () => {
  const seen = []
  const found = ['worker', 'src'].flatMap((dir) =>
    sourceFiles(join(root, dir)).flatMap((path) => {
      const file = relative(root, path).replaceAll('\\', '/')
      seen.push(file)
      const source = readFileSync(path, 'utf8')
      return file in ALLOWED_FILES ? checkAllowedFile(file, source, ALLOWED_FILES[file]) : findOutboundCalls(file, source)
    }),
  )
  assert.deepEqual(found, [], 'ADR 0010: no one but Akahu (only if you use Sync) and your own Cloudflare account (Access, and the D1 usage figures if you set their token). A new call belongs in ALLOWED_FILES, with a test in worker/outbound.test.ts.')
  assert.deepEqual(Object.keys(ALLOWED_FILES).filter((file) => !seen.includes(file)), [], 'a file in ALLOWED_FILES that is not in worker/ or src/')
})

test('an allowed file is held to one call, to one address', () => {
  const allowed = { url: 'https://api.example.test/graphql', urlName: 'API_URL' }
  const ok = "// see https://docs.example.test/page\nexport const API_URL = 'https://api.example.test/graphql'\nconst res = await fetch(API_URL, { method: 'POST' })"
  assert.deepEqual(checkAllowedFile('x.ts', ok, allowed), [])
  // An API reached by path: the call may be a template literal, but only one that BEGINS with the constant.
  const byPath = ok.replace('fetch(API_URL', 'fetch(`${API_URL}/accounts/${id}/transactions`')
  assert.deepEqual(checkAllowedFile('x.ts', byPath, allowed), [])
  const bad = {
    'a template literal that does not begin with the constant': ok.replace('fetch(API_URL', 'fetch(`${host}${API_URL}`'),
    'a second call': `${ok}\nawait fetch(API_URL)`,
    'no call at all': "export const API_URL = 'https://api.example.test/graphql'",
    'a call to something else': ok.replace('fetch(API_URL', 'fetch(otherUrl'),
    'a call to a literal address': ok.replace('fetch(API_URL', "fetch('https://api.example.test/graphql'"),
    'another address named': `${ok}\nconst other = 'https://github.com/markc647/fernledger'`,
    'the address changed': ok.replaceAll('api.example.test', 'elsewhere.test'),
    'a socket as well': `${ok}\nnew WebSocket(API_URL)`,
  }
  for (const [name, source] of Object.entries(bad)) assert.notDeepEqual(checkAllowedFile('x.ts', source, allowed), [], name)
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
