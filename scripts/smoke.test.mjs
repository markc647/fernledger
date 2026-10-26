import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtEntryScript, smokeCheck, smokeCheckWithRetries, smokeSettings } from './smoke.mjs'

const ENTRY = '/assets/index-Abc123.js'
const PAGE = `<script src="/theme-init.js"></script><script type="module" crossorigin src="${ENTRY}"></script>`
const SETTINGS = { origin: 'https://fernledger.example.workers.dev', clientId: 'made-up-id.access', clientSecret: 'made-up-secret', entryScript: ENTRY }

// A stand-in for the site behind Access. `site` says what each request gets; `calls` records what was asked.
function fakeSite({ page = PAGE, me = 401, open = 302, tokenRefused = false, down = false } = {}) {
  const calls = []
  const fetchFn = async (url, { headers }) => {
    const withToken = 'CF-Access-Client-Secret' in headers
    calls.push({ url, withToken })
    if (down) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    if (!withToken) return new Response(open === 200 ? page : '', { status: open })
    if (tokenRefused) return new Response('', { status: 403 })
    if (url.endsWith('/api/me')) return new Response('{"error":"Unauthorised"}', { status: me })
    return new Response(page, { status: 200 })
  }
  return { fetchFn, calls }
}

test('the smoke check passes when Access lets the token in to this build, the Worker refuses it, and Access guards the page', async () => {
  const site = fakeSite()
  assert.deepEqual(await smokeCheck(SETTINGS, site.fetchFn), [])
  assert.deepEqual(
    site.calls.map((c) => [new URL(c.url).pathname, c.withToken]),
    [['/', true], ['/api/me', true], ['/', false]],
  )
})

test('the smoke check fails when the live page is an older build', async () => {
  const failed = await smokeCheck(SETTINGS, fakeSite({ page: PAGE.replace(ENTRY, '/assets/index-Old999.js') }).fetchFn)
  assert.match(failed.join('\n'), /not this build/)
})

test('the smoke check fails when Access refuses the token, and says where to look', async () => {
  const failed = await smokeCheck(SETTINGS, fakeSite({ tokenRefused: true }).fetchFn)
  assert.match(failed[0], /expected 200, got 403.*Service Auth policy/)
})

test('the smoke check fails when the Worker lets an identity with no email in', async () => {
  const failed = await smokeCheck(SETTINGS, fakeSite({ me: 200 }).fetchFn)
  assert.match(failed.join('\n'), /api\/me .*expected 401.*got 200/)
})

test('the smoke check fails when the app is served without the token', async () => {
  const failed = await smokeCheck(SETTINGS, fakeSite({ open: 200 }).fetchFn)
  assert.match(failed.join('\n'), /Access is not in front of it/)
})

test('the smoke check reports a site it cannot reach, and never prints the token', async () => {
  const failed = await smokeCheck(SETTINGS, fakeSite({ down: true }).fetchFn)
  assert.equal(failed.length, 3)
  assert.match(failed[0], /could not connect \(ENOTFOUND\)/)
  assert.ok(!failed.join('\n').includes(SETTINGS.clientSecret))
})

test('the smoke check tries again until the new version is served', async () => {
  let asked = 0
  const site = fakeSite()
  const slow = async (url, init) => (++asked <= 3 ? new Response(PAGE.replace(ENTRY, '/old.js'), { status: 200 }) : site.fetchFn(url, init))
  assert.deepEqual(await smokeCheckWithRetries(SETTINGS, { fetchFn: slow, waitMs: 0 }), [])
  assert.deepEqual(await smokeCheckWithRetries(SETTINGS, { fetchFn: fakeSite({ me: 200 }).fetchFn, tries: 2, waitMs: 0 }).then((f) => f.length), 1)
})

test('smoke settings name what is missing, and refuse an address that is not https', () => {
  assert.deepEqual(smokeSettings({ FERNLEDGER_URL: 'https://x.example' }).missing, ['FERNLEDGER_SMOKE_ID', 'FERNLEDGER_SMOKE_SECRET'])
  const token = { FERNLEDGER_SMOKE_ID: 'id', FERNLEDGER_SMOKE_SECRET: 'secret' }
  assert.ok(smokeSettings({ ...token, FERNLEDGER_URL: 'http://x.example' }).problem)
  assert.ok(smokeSettings({ ...token, FERNLEDGER_URL: 'not an address' }).problem)
  assert.equal(smokeSettings({ ...token, FERNLEDGER_URL: 'https://x.example/some/page' }).origin, 'https://x.example')
})

test("the build's entry script is the module script in index.html", () => {
  assert.equal(builtEntryScript(PAGE), ENTRY)
  assert.equal(builtEntryScript('<script src="/theme-init.js"></script>'), null)
})
