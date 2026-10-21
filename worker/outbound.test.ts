import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_CRON } from './backup'
import { app } from './app'
import worker from './index'

// Seam 1, privacy promise: the app contacts no one but Akahu (only if you use Sync) and your own Cloudflare account: its
// Access, to check a sign-in, and, only if you set a token for it, its D1 usage figures (README: Security and privacy; ADR 0010).
// Every request below goes through the real Worker with `fetch` replaced by a recorder that refuses to answer, so
// a code path that makes an outbound call shows up here as a host that isn't allowed.
//
// Allowed host: the Deployer's own Cloudflare Access team domain. Verifying a sign-in fetches its public keys. That is
// the Deployer's own sign-in service, not a third party. Anything else, GitHub in particular, fails this test.
// The one other address is Cloudflare's GraphQL Analytics API, which the D1 usage bar asks for the account's own usage
// (worker/d1-usage.ts). It is not in ALLOWED_HOSTS: only the tests that set CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID may see
// it, as exactly this URL, once, from the one route that asks. With the secrets unset nothing may reach it.
// Akahu is the one third party the Worker ever contacts, and only with both Akahu tokens set (ADR 0008, ADR 0010). It is not in
// ALLOWED_HOSTS either: only the tests that set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN may see it, as its own host, from the Admin's
// route for listing Akahu accounts, from the Sync cron, and from "Run a Sync now", which is that same Sync started by hand.
// With the tokens unset nothing may reach it.
const ACCESS_HOST = env.ACCESS_TEAM_DOMAIN!
const ALLOWED_HOSTS = [ACCESS_HOST]
const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4/graphql'
const USAGE_SECRETS = { CF_ANALYTICS_TOKEN: 'cf_token_SECRET_VALUE_1', CF_ACCOUNT_ID: 'account_SECRET_VALUE_2' }
const AKAHU_HOST = 'api.akahu.io'
const AKAHU_SECRETS = { AKAHU_APP_TOKEN: 'app_token_SECRET_VALUE_3', AKAHU_USER_TOKEN: 'user_token_SECRET_VALUE_4' }

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

/** One request as the Admin. With `secrets` the Worker runs with them set, which needs `worker.fetch` (CODING_STANDARDS.md: Tests). */
async function call(path: string, opts: { method?: string; body?: unknown } = {}, secrets?: Partial<Env>) {
  const headers: Record<string, string> = { Cookie: 'fernledger_dev_as=admin' }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  const request = new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  if (!secrets) return exports.default.fetch(request)
  const ctx = createExecutionContext()
  const res = await worker.fetch!(request as never, { ...env, ...secrets }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

// Every route the app declares, as Hono lists them, with the request that exercises it. A route added without an entry
// here fails 'exercises every route the app declares' below, so a new route can't escape this test.
type Opts = { method?: string; body?: unknown }
type Exercise = { route: string; path: (accountId: number) => string; opts?: Opts | ((accountId: number) => Opts) }
// IDs made by earlier exercises, for the later ones that need them (the Category and Transaction are read lazily, after they exist).
const made = { categoryId: 0, transactionId: 0, ruleId: 0, keptId: 0 }
const EXERCISES: Exercise[] = [
  // A second Account, with the other half of a Transfer: the next chunk's $10.00 out pairs with this $10.00 in, so the Not a Transfer routes
  // below have a pairing to say no to. Its name sorts after the first Account's number, so the first Account is still the first listed.
  { route: 'POST /api/imports/chunks', path: () => '/api/imports/chunks', opts: { method: 'POST', body: {
      account: { number: '99-9999-9999999-98', name: 'Z example' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows: [{ date: '2026-10-01', uniqueId: 'IDB', tranType: 'TFR', chequeNumber: null, payee: 'EXAMPLE TRANSFER', bankMemo: 'TFR', amountCents: 1000 }],
    } } },
  // Then the first Account: it creates the Account that the PATCH below renames.
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
  // The charts add up those balances, and what the chunk spent.
  { route: 'GET /api/charts/net-worth', path: () => '/api/charts/net-worth?range=24-months' },
  { route: 'GET /api/charts/spending', path: () => '/api/charts/spending?from=2026-10-01&to=2026-10-31' },
  // Then a Category and the Transaction that chunk made, for the Category routes and the Override and Note on that Transaction.
  { route: 'POST /api/categories', path: () => '/api/categories', opts: { method: 'POST', body: { name: 'Example category' } } },
  { route: 'GET /api/categories', path: () => '/api/categories' },
  { route: 'PATCH /api/categories/:id', path: () => `/api/categories/${made.categoryId}`, opts: () => ({ method: 'PATCH', body: { name: 'Example renamed' } }) },
  { route: 'PUT /api/transactions/:id/override', path: () => `/api/transactions/${made.transactionId}/override`, opts: () => ({ method: 'PUT', body: { categoryId: made.categoryId } }) },
  { route: 'PUT /api/transactions/:id/note', path: () => `/api/transactions/${made.transactionId}/note`, opts: () => ({ method: 'PUT', body: { note: 'Example note' } }) },
  // That Transaction is half of a pairing: say it is not a Transfer, then treat it as one again (which pairs it with the other half).
  { route: 'POST /api/transactions/:id/not-transfer', path: () => `/api/transactions/${made.transactionId}/not-transfer`, opts: { method: 'POST', body: {} } },
  { route: 'DELETE /api/transactions/:id/not-transfer', path: () => `/api/transactions/${made.transactionId}/not-transfer`, opts: { method: 'DELETE', body: {} } },
  // A Budget for that Category, and the two ways of reading Budgets (vs-actual reads what that chunk imported).
  { route: 'PUT /api/budgets/:categoryId', path: () => `/api/budgets/${made.categoryId}`, opts: { method: 'PUT', body: { effectiveFrom: '2026-10', amountCents: 50_000 } } },
  { route: 'GET /api/budgets', path: () => '/api/budgets?month=2026-10' },
  { route: 'GET /api/budgets/vs-actual', path: () => '/api/budgets/vs-actual?month=2026-10' },
  // The Loans Report lists the Transactions of a Loans Category, so make that Category one (its Budget is kept, and unused), then read it.
  { route: 'PUT /api/categories/:id/kind', path: () => `/api/categories/${made.categoryId}/kind`, opts: { method: 'PUT', body: { kind: 'loans' } } },
  { route: 'GET /api/reports/loans', path: () => `/api/reports/loans?categoryId=${made.categoryId}&from=2026-10-01&to=2026-10-31` },
  // Last, because once it is Income the Category can have no Budget.
  { route: 'PUT /api/categories/:id/kind', path: () => `/api/categories/${made.categoryId}/kind`, opts: { method: 'PUT', body: { kind: 'income' } } },
  // The Rules, on that Category: add one, then everything that reads or changes it, and last remove it.
  { route: 'POST /api/rules', path: () => '/api/rules', opts: () => ({ method: 'POST', body: { textContains: 'EXAMPLE', categoryId: made.categoryId } }) },
  { route: 'GET /api/rules', path: () => '/api/rules' },
  { route: 'POST /api/rules/preview', path: () => '/api/rules/preview', opts: { method: 'POST', body: { textContains: 'EXAMPLE' } } },
  { route: 'PUT /api/rules/:id', path: () => `/api/rules/${made.ruleId}`, opts: { method: 'PUT', body: { textContains: 'EXAMPLE SHOP', transfer: true } } },
  { route: 'PUT /api/rules/order', path: () => '/api/rules/order', opts: () => ({ method: 'PUT', body: { ids: [made.ruleId] } }) },
  // Create Rule, in a Transaction's Edit panel: a Rule made from the Transaction that chunk made, after the order above (which names exactly the Rules in use).
  { route: 'POST /api/rules/from-transaction', path: () => '/api/rules/from-transaction', opts: () => ({ method: 'POST', body: { transactionId: made.transactionId, textContains: 'EXAMPLE', categoryId: made.categoryId } }) },
  // Applying the Rules to the Transaction on file: start the run, read it, stop it while it runs (a stop that finds none running is
  // refused), and do a step, which answers with the run it finds.
  { route: 'POST /api/rules/rerun', path: () => '/api/rules/rerun', opts: { method: 'POST', body: {} } },
  { route: 'GET /api/rules/rerun', path: () => '/api/rules/rerun' },
  { route: 'POST /api/rules/rerun/stop', path: () => '/api/rules/rerun/stop', opts: { method: 'POST', body: {} } },
  { route: 'POST /api/rules/rerun/step', path: () => '/api/rules/rerun/step', opts: { method: 'POST', body: {} } },
  { route: 'DELETE /api/rules/:id', path: () => `/api/rules/${made.ruleId}`, opts: { method: 'DELETE', body: {} } },
  { route: 'DELETE /api/categories/:id', path: () => `/api/categories/${made.categoryId}`, opts: { method: 'DELETE', body: {} } },
  { route: 'GET /api/imports/imported/:accountId', path: (id) => `/api/imports/imported/${id}` },
  { route: 'PUT /api/accounts/:id/cutover-date', path: (id) => `/api/accounts/${id}/cutover-date`, opts: { method: 'PUT', body: { cutoverDate: '2026-11-01' } } },
  // The Account Link. Writing it contacts no one: it records which Akahu account the Sync cron will ask for, and the Admin picked
  // it from GET /api/akahu/accounts, which is the route that does the asking.
  { route: 'PUT /api/accounts/:id/akahu-link', path: (id) => `/api/accounts/${id}/akahu-link`, opts: { method: 'PUT', body: { akahuAccountId: 'acc_example00000000000000' } } },
  { route: 'POST /api/imports/clear-history', path: () => '/api/imports/clear-history', opts: (id) => ({ method: 'POST', body: { accountId: id } }) },
  // A replace that stops after its first part holds the Overrides and Notes of the removed Transaction (it has a Note by now),
  // which the next two routes forecast and discard.
  { route: 'POST /api/imports/chunks', path: () => '/api/imports/chunks', opts: { method: 'POST', body: {
      account: { number: '99-9999-9999999-99' },
      chunk: { index: 0, count: 2 },
      file: { adapterId: 'asb', rowCount: 2, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows: [{ date: '2026-10-02', uniqueId: 'ID2', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -1000 }],
      replace: true,
    } } },
  { route: 'POST /api/imports/carry-preview', path: () => '/api/imports/carry-preview', opts: (id) => ({ method: 'POST', body: { accountId: id, rows: [{ uniqueId: 'ID1', amountCents: -1000 }] } }) },
  { route: 'POST /api/imports/discard-held', path: () => '/api/imports/discard-held', opts: (id) => ({ method: 'POST', body: { accountId: id } }) },
  { route: 'GET /api/me', path: () => '/api/me' },
  { route: 'GET /api/settings', path: () => '/api/settings' },
  { route: 'GET /api/features', path: () => '/api/features' },
  // The D1 usage bar: with no secrets it answers Not set up (503) and goes nowhere. Only the run below that sets both reaches Cloudflare's API.
  { route: 'GET /api/d1-usage', path: () => '/api/d1-usage' },
  // Akahu, the same way: with no tokens it answers Not set up (503) and goes nowhere. Only the run below that sets both reaches Akahu.
  { route: 'GET /api/akahu/accounts', path: () => '/api/akahu/accounts' },
  // "Run a Sync now": the same, and it is the Admin's own Sync, so with the tokens set it asks Akahu for the Account linked
  // above. With them unset it is Not set up (503) and contacts no one, exactly as the cron does.
  { route: 'POST /api/sync/runs', path: () => '/api/sync/runs', opts: { method: 'POST', body: {} } },
  { route: 'GET /api/accounts', path: () => '/api/accounts' },
  { route: 'GET /api/change-log', path: () => '/api/change-log' },
  { route: 'GET /api/transactions', path: () => '/api/transactions?text=example&from=2026-01-01&sort=amount&dir=asc&transfers=exclude' },
  { route: 'GET /api/transactions/export.csv', path: () => '/api/transactions/export.csv?text=example&from=2026-01-01&transfers=exclude' },
  { route: 'GET /api/transactions/:id', path: () => `/api/transactions/${made.transactionId}` },
  { route: 'GET /api/reports/transactions', path: (id) => `/api/reports/transactions?accountId=${id}&from=2026-10-01&to=2026-10-31` },
  { route: 'GET /api/reports/balances', path: (id) => `/api/reports/balances?accountId=${id}&from=2026-10-01&to=2026-10-31` },
  { route: 'GET /api/reports/budget-vs-actual', path: () => '/api/reports/budget-vs-actual?from=2026-09-15&to=2026-10-31' },
  { route: 'GET /api/reports/spending', path: (id) => `/api/reports/spending?accountId=${id}&from=2026-10-01&to=2026-10-31` },
  { route: 'GET /api/reports/income-vs-spending', path: (id) => `/api/reports/income-vs-spending?accountId=${id}&from=2026-10-01&to=2026-10-31` },
  // The Reports the Admin has made: showing the Report above keeps it (the page asks), then the list, and last the Report is taken off the list.
  { route: 'POST /api/kept-reports', path: () => '/api/kept-reports', opts: (id) => ({ method: 'POST', body: { report: 'transactions', accountId: id, from: '2026-10-01', to: '2026-10-31' } }) },
  { route: 'GET /api/kept-reports', path: () => '/api/kept-reports' },
  { route: 'DELETE /api/kept-reports/:id', path: () => `/api/kept-reports/${made.keptId}`, opts: { method: 'DELETE', body: {} } },
  { route: 'PATCH /api/settings', path: () => '/api/settings', opts: { method: 'PATCH', body: { app_title: 'Example family' } } },
  { route: 'PATCH /api/accounts/:id', path: (id) => `/api/accounts/${id}`, opts: { method: 'PATCH', body: { name: 'Example savings' } } },
]
// Not routes of their own: an unknown API path, and anything outside /api (the static assets).
const OTHER_PATHS = ['/api/no-such-route', '/not-api']

/** Runs every exercise above, in order, as the Admin, with the Worker's secrets as given (none, if not). */
async function exerciseEveryRoute(secrets?: Partial<Env>) {
  // The database keeps what an earlier test in this file wrote, and the exercises start from none (a Transfer's pairing, an Account's history).
  // The starter Categories and the Settings stay: the exercises add and remove their own.
  const tables = ['kept_reports', 'carry_over', 'balance_checks', 'budgets', 'rules', 'transactions', 'accounts', 'change_log', 'data_migration_progress']
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  let accountId = 0
  for (const { route, path, opts } of EXERCISES) {
    const res = await call(path(accountId), typeof opts === 'function' ? opts(accountId) : opts, secrets)
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
    if (route === 'POST /api/kept-reports') {
      expect(res.status).toBe(201)
      made.keptId = ((await res.json()) as { id: number }).id
    }
    // Each exercise must reach its handler's success path, or it proves nothing about that route. (Clear-history refuses a small history.)
    // The usage route is Not set up (503) without its secrets, and with them it reaches its call, which the recorder refuses: Usage unavailable (502).
    // A feature's route is Not set up (503) without its own secrets, and with them it reaches its call, which the recorder refuses (502).
    if (route === 'GET /api/d1-usage') expect(res.status, route).toBe(secrets?.CF_ANALYTICS_TOKEN ? 502 : 503)
    else if (route === 'GET /api/akahu/accounts') expect(res.status, route).toBe(secrets?.AKAHU_APP_TOKEN ? 502 : 503)
    // A Sync reports what it did rather than failing: with the tokens set it reaches Akahu, the recorder refuses, and the
    // Account comes back unfinished with a reason (200). Without them it never gets that far: Not set up (503).
    else if (route === 'POST /api/sync/runs') expect(res.status, route).toBe(secrets?.AKAHU_APP_TOKEN ? 200 : 503)
    else if (route !== 'POST /api/imports/clear-history') expect(res.status, route).toBeLessThan(400)
  }
  for (const path of OTHER_PATHS) await call(path, {}, secrets)
}

describe('outbound calls', () => {
  it('exercises every route the app declares', () => {
    const declared = new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))
    expect([...new Set(EXERCISES.map((e) => e.route))].sort()).toEqual([...declared].sort())
  })

  it('notices a call to a host that is not allowed (the tripwire itself)', async () => {
    await fetch('https://github.com/markc647/fernledger/releases/latest').catch(() => {})
    expect(hostsContacted().filter((host) => !ALLOWED_HOSTS.includes(host))).toEqual(['github.com'])
  })

  // One request per route (about 0.5 s alone), but the full suite runs many workerd instances at once and these tests have
  // taken over 5 s on a busy machine, so they have a longer limit than the 5 s default. It is a load allowance, not a slow route.
  it('makes none from any route, signed in as the Admin', { timeout: 30_000 }, async () => {
    await exerciseEveryRoute()

    expect(attempts).toEqual([])
  })

  it('makes none from the scheduled handler, on any cron', async () => {
    for (const cron of CRONS) await worker.scheduled!(createScheduledController({ cron, scheduledTime: new Date('2026-10-11T15:00:00Z') }), env)

    expect(attempts).toEqual([])
  })

  // The D1 usage bar's token is the Deployer's own, and with it set the Worker asks Cloudflare's GraphQL Analytics API for the account's
  // usage (ADR 0010). That is one call to one address, from the one route that exists for it: every route is run again with both secrets
  // set, and the recorder must see that URL once and nothing else.
  it('with the D1 usage secrets set, contacts only api.cloudflare.com/client/v4/graphql, once, from the usage route', { timeout: 30_000 }, async () => {
    await exerciseEveryRoute(USAGE_SECRETS)

    expect(attempts).toEqual([CLOUDFLARE_API_URL])
  })

  it('with the D1 usage secrets set, makes none from the scheduled handler, on any cron', async () => {
    for (const cron of CRONS) await worker.scheduled!(createScheduledController({ cron, scheduledTime: new Date('2026-10-11T15:00:00Z') }), { ...env, ...USAGE_SECRETS })

    expect(attempts).toEqual([])
  })

  // Akahu Sync: with both tokens set, the Admin's route for listing Akahu accounts is the only route that reaches Akahu, and it
  // reaches nothing else.
  it('with the Akahu tokens set, contacts only api.akahu.io, from the Akahu route and a Sync the Admin runs', { timeout: 30_000 }, async () => {
    await exerciseEveryRoute(AKAHU_SECRETS)

    expect(hostsContacted()).toEqual([AKAHU_HOST])
    // Exactly three: the Admin's list of Akahu accounts, and what "Run a Sync now" asks for: the list again, for the details of the
    // Account it syncs (ticket 42), and one page of Transactions for the Account linked by the exercises. A fourth would be a
    // route that reaches Akahu without ADR 0010's reason to.
    expect(attempts).toHaveLength(3)
    expect(attempts.filter((url) => url.includes('/transactions'))).toHaveLength(1)
  })

  // And on the cron: a linked Account is what makes Sync ask at all, so this is the one place the scheduled handler calls out.
  it('with the Akahu tokens set and an Account linked, contacts only api.akahu.io, from the Sync cron', async () => {
    await env.DB.prepare('DELETE FROM transactions').run()
    await env.DB.prepare('DELETE FROM accounts').run()
    await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id, cutover_date) VALUES ('99-9999-9999999-97', 'Example linked', 'acc_example00000000000001', '2026-10-01')").run()

    for (const cron of CRONS) await worker.scheduled!(createScheduledController({ cron, scheduledTime: new Date('2026-10-11T15:00:00Z') }), { ...env, ...AKAHU_SECRETS })

    expect(hostsContacted()).toEqual([AKAHU_HOST])
  })

  it('with no Akahu tokens, the Sync cron contacts no one even with an Account linked', async () => {
    await env.DB.prepare('DELETE FROM transactions').run()
    await env.DB.prepare('DELETE FROM accounts').run()
    await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id, cutover_date) VALUES ('99-9999-9999999-96', 'Example linked', 'acc_example00000000000002', '2026-10-01')").run()

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
