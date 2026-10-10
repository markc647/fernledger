import { createScheduledController } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_CRON } from './backup'
import { app } from './app'
import worker from './index'

// Seam 1, privacy promise: the app contacts no one but Akahu (only if you use Sync) and, to check a sign-in, your own
// Cloudflare Access (README: Security and privacy; ADR 0010).
// Every request below goes through the real Worker with `fetch` replaced by a recorder that refuses to answer, so
// a code path that makes an outbound call shows up here as a host that isn't allowed.
//
// Allowed host: the Deployer's own Cloudflare Access team domain. Verifying a sign-in fetches its public keys. That is
// the Deployer's own sign-in service, not a third party, and it is the only call the app makes today. Anything else,
// GitHub in particular, fails this test. Akahu Sync is not built yet; when it is, its host is added here together with
// an exercise that reaches it, not by widening the list in passing.
const ACCESS_HOST = env.ACCESS_TEAM_DOMAIN!
const ALLOWED_HOSTS = [ACCESS_HOST]

// Same as `triggers.crons` in wrangler.jsonc; scripts/wrangler-config.test.mjs fails if the two differ.
const CRONS = ['0 18 * * *', '0 22 * * *', BACKUP_CRON]

const origin = 'http://localhost:5173'
const attempts: string[] = []

beforeEach(() => {
  attempts.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    attempts.push(new Request(input, init).url)
    throw new Error('No network in tests')
  })
})
afterEach(() => vi.unstubAllGlobals())

const hostsContacted = () => [...new Set(attempts.map((url) => new URL(url).host))]

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: 'fernledger_dev_as=admin' }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

// Every route the app declares, as Hono lists them, with the request that exercises it. A route added without an entry
// here fails 'exercises every route the app declares' below, so a new route can't escape this test.
type Opts = { method?: string; body?: unknown }
type Exercise = { route: string; path: (accountId: number) => string; opts?: Opts | ((accountId: number) => Opts) }
// IDs made by earlier exercises, for the later ones that need them (the Category and Transaction are read lazily, after they exist).
const made = { categoryId: 0, transactionId: 0, ruleId: 0 }
const EXERCISES: Exercise[] = [
  // First: it creates the Account that the PATCH below renames.
  { route: 'POST /api/imports/chunks', path: () => '/api/imports/chunks', opts: { method: 'POST', body: {
      account: { number: '99-9999-9999999-99' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows: [{ date: '2026-10-01', uniqueId: 'ID1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -1000 }],
    } } },
  // The balance routes read what that chunk recorded.
  { route: 'GET /api/balances', path: () => '/api/balances' },
  { route: 'GET /api/balances/:accountId/history', path: (id) => `/api/balances/${id}/history` },
  { route: 'GET /api/balance-checks', path: () => '/api/balance-checks' },
  // Then a Category and the Transaction that chunk made, for the Category routes and the Override and Note on that Transaction.
  { route: 'POST /api/categories', path: () => '/api/categories', opts: { method: 'POST', body: { name: 'Example category' } } },
  { route: 'GET /api/categories', path: () => '/api/categories' },
  { route: 'PATCH /api/categories/:id', path: () => `/api/categories/${made.categoryId}`, opts: () => ({ method: 'PATCH', body: { name: 'Example renamed' } }) },
  { route: 'PUT /api/transactions/:id/override', path: () => `/api/transactions/${made.transactionId}/override`, opts: () => ({ method: 'PUT', body: { categoryId: made.categoryId } }) },
  { route: 'PUT /api/transactions/:id/note', path: () => `/api/transactions/${made.transactionId}/note`, opts: () => ({ method: 'PUT', body: { note: 'Example note' } }) },
  // The Rules, on that Category: add one, then everything that reads or changes it, and last remove it.
  { route: 'POST /api/rules', path: () => '/api/rules', opts: () => ({ method: 'POST', body: { textContains: 'EXAMPLE', categoryId: made.categoryId } }) },
  { route: 'GET /api/rules', path: () => '/api/rules' },
  { route: 'POST /api/rules/preview', path: () => '/api/rules/preview', opts: { method: 'POST', body: { textContains: 'EXAMPLE' } } },
  { route: 'PUT /api/rules/:id', path: () => `/api/rules/${made.ruleId}`, opts: { method: 'PUT', body: { textContains: 'EXAMPLE SHOP', transfer: true } } },
  { route: 'PUT /api/rules/order', path: () => '/api/rules/order', opts: () => ({ method: 'PUT', body: { ids: [made.ruleId] } }) },
  { route: 'DELETE /api/rules/:id', path: () => `/api/rules/${made.ruleId}`, opts: { method: 'DELETE', body: {} } },
  { route: 'DELETE /api/categories/:id', path: () => `/api/categories/${made.categoryId}`, opts: { method: 'DELETE', body: {} } },
  { route: 'GET /api/imports/imported/:accountId', path: (id) => `/api/imports/imported/${id}` },
  { route: 'PUT /api/accounts/:id/cutover-date', path: (id) => `/api/accounts/${id}/cutover-date`, opts: { method: 'PUT', body: { cutoverDate: '2026-11-01' } } },
  { route: 'POST /api/imports/clear-history', path: () => '/api/imports/clear-history', opts: (id) => ({ method: 'POST', body: { accountId: id } }) },
  { route: 'GET /api/me', path: () => '/api/me' },
  { route: 'GET /api/settings', path: () => '/api/settings' },
  { route: 'GET /api/features', path: () => '/api/features' },
  { route: 'GET /api/accounts', path: () => '/api/accounts' },
  { route: 'GET /api/change-log', path: () => '/api/change-log' },
  { route: 'GET /api/transactions', path: () => '/api/transactions?text=example&from=2026-01-01&sort=amount&dir=asc' },
  { route: 'GET /api/transactions/export.csv', path: () => '/api/transactions/export.csv?text=example&from=2026-01-01' },
  { route: 'GET /api/transactions/:id', path: () => `/api/transactions/${made.transactionId}` },
  { route: 'PATCH /api/settings', path: () => '/api/settings', opts: { method: 'PATCH', body: { app_title: 'Example family' } } },
  { route: 'PATCH /api/accounts/:id', path: (id) => `/api/accounts/${id}`, opts: { method: 'PATCH', body: { name: 'Example savings' } } },
]
// Not routes of their own: an unknown API path, and anything outside /api (the static assets).
const OTHER_PATHS = ['/api/no-such-route', '/not-api']

describe('outbound calls', () => {
  it('exercises every route the app declares', () => {
    const declared = new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))
    expect([...new Set(EXERCISES.map((e) => e.route))].sort()).toEqual([...declared].sort())
  })

  it('notices a call to a host that is not allowed (the tripwire itself)', async () => {
    await fetch('https://github.com/markc647/fernledger/releases/latest').catch(() => {})
    expect(hostsContacted().filter((host) => !ALLOWED_HOSTS.includes(host))).toEqual(['github.com'])
  })

  // One request per route (about 0.5 s alone), but the full suite runs many workerd instances at once and this test has
  // taken over 5 s on a busy machine, so it has a longer limit than the 5 s default. It is a load allowance, not a slow route.
  it('makes none from any route, signed in as the Admin', { timeout: 30_000 }, async () => {
    let accountId = 0
    for (const { route, path, opts } of EXERCISES) {
      const res = await call(path(accountId), typeof opts === 'function' ? opts(accountId) : opts)
      if (route === 'POST /api/imports/chunks') {
        expect(res.status).toBe(200)
        accountId = ((await (await call('/api/accounts')).json()) as { id: number }[])[0].id
        made.transactionId = ((await (await call('/api/transactions')).json()) as { transactions: { id: number }[] }).transactions[0].id
      }
      if (route === 'POST /api/categories') {
        expect(res.status).toBe(201)
        made.categoryId = ((await res.json()) as { id: number }).id
      }
      if (route === 'POST /api/rules') {
        expect(res.status).toBe(201)
        made.ruleId = ((await res.json()) as { id: number }).id
      }
      // Each exercise must reach its handler's success path, or it proves nothing about that route. (Clear-history refuses a small history.)
      if (route !== 'POST /api/imports/clear-history') expect(res.status, route).toBeLessThan(400)
    }
    for (const path of OTHER_PATHS) await call(path)

    expect(attempts).toEqual([])
  })

  it('makes none from the scheduled handler, on any cron', async () => {
    for (const cron of CRONS) await worker.scheduled!(createScheduledController({ cron, scheduledTime: new Date('2026-10-11T15:00:00Z') }), env)

    expect(attempts).toEqual([])
  })

  it('contacts only the Deployer\'s own Access sign-in service when verifying a sign-in', async () => {
    const part = (value: object) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const token = `${part({ alg: 'RS256', kid: 'k1' })}.${part({ email: 'admin@example.com' })}.c2ln`
    const res = await exports.default.fetch(new Request('https://app.test/api/me', { headers: { 'Cf-Access-Jwt-Assertion': token } }))

    expect(res.status).toBe(401)
    expect(hostsContacted()).toEqual([ACCESS_HOST])
  })
})
