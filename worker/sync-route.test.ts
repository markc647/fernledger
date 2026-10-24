import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

// Seam 1: "Run a Sync now" (POST /api/sync/runs) through the real request path, with Akahu faked at `fetch`.
//
// What the ticket promises: the Admin gets a run now and is told what happened to each Account; a Member is refused; with the
// Akahu tokens unset the answer is "Not set up" and no call goes out; and a second run while the first's rows are already in
// place writes no duplicate (ADR 0013: nothing locks, because every write Sync makes is repeatable).

// Deliberately recognisable fakes: a leak into a response or a log line is then obvious. Not real tokens.
const SECRETS = { AKAHU_APP_TOKEN: 'app_token_SECRET_VALUE_1', AKAHU_USER_TOKEN: 'user_token_SECRET_VALUE_2' }
const LINKED = 'acc_linked000000000000001'
const origin = 'http://localhost:5173'

let calls: string[] = []
let logged: string[] = []
let accountId = 0

const asJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// The pending-money call a run makes (worker/pending.ts) is answered with nothing pending unless a test's own `respond` is
// given the path: these tests are about the Transactions and what the Admin is told, and pending rows would only be noise.
const stubAkahu = (respond: (url: string) => Response) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new Request(input, init).url
    calls.push(url)
    return new URL(url).pathname === '/v1/transactions/pending' ? asJson({ items: [] }) : respond(url)
  })

const transaction = (id: string) => ({
  _id: id,
  _account: LINKED,
  date: '2026-10-15T00:00:00.000Z',
  created_at: '2026-10-15T20:05:00.000Z',
  description: 'COUNTDOWN ORMISTON',
  amount: -42.5,
  type: 'EFTPOS',
})

/** One request. `secrets` needs `worker.fetch`, because only that can change the Worker's env (CODING_STANDARDS.md: Tests). */
async function runNow(opts: { role?: string; body?: unknown; secrets?: Partial<Env> } = {}) {
  const request = new Request(`${origin}/api/sync/runs`, {
    method: 'POST',
    headers: { Cookie: `fernledger_dev_as=${opts.role ?? 'admin'}`, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body ?? {}),
  })
  if (!opts.secrets) return exports.default.fetch(request)
  const ctx = createExecutionContext()
  const res = await worker.fetch!(request as never, { ...env, ...opts.secrets, DB: env.DB } as never, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

const rowCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'sync'").first<{ n: number }>())!.n

beforeEach(async () => {
  calls = []
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
  await env.DB.prepare('DELETE FROM transactions').run()
  await env.DB.prepare('DELETE FROM accounts').run()
  const { meta } = await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id, cutover_date) VALUES ('99-9999-9999999-01', 'Everyday', ?, '2026-10-01')").bind(LINKED).run()
  accountId = meta.last_row_id
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /api/sync/runs', () => {
  it('runs a Sync and says what each Account did', async () => {
    stubAkahu(() => asJson({ items: [transaction('trans_0000000000000000001')], cursor: { next: null } }))

    const res = await runNow({ secrets: SECRETS })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ran: true, success: true, pending: 0, accounts: [{ accountId, written: 1, removed: 0, complete: true }] })
    expect(await rowCount()).toBe(1)
  })

  // A manual run is its own invocation with the whole 50 queries, so it takes the four Accounts a cron run does (worker/sync.ts: MAX_QUERIES).
  it('syncs four linked Accounts in one request', async () => {
    stubAkahu((url) => asJson({ items: [{ ...transaction(`trans_${new URL(url).pathname.split('/')[3]}`), _account: new URL(url).pathname.split('/')[3] }], cursor: { next: null } }))
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id, cutover_date) VALUES (?, ?, ?, '2026-10-01')")
        .bind(`99-9999-9999999-1${i}`, `Spare ${i}`, `acc_spare00000000000000${i}`)
        .run()
    }

    const res = await runNow({ secrets: SECRETS })

    const body = (await res.json()) as { success: boolean; accounts: { complete: boolean }[] }
    expect(body.accounts).toHaveLength(4)
    expect(body.accounts.every((outcome) => outcome.complete)).toBe(true)
    expect(body.success).toBe(true)
  })

  it('names the reason an Account failed, and does not call the run a success', async () => {
    stubAkahu(() => asJson({ message: 'Unauthorized' }, 401))

    const res = await runNow({ secrets: SECRETS })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ran: true, success: false, pending: 0, accounts: [{ accountId, written: 0, removed: 0, complete: false, failure: 'refused' }] })
    // The reason is one of Akahu's three fixed words, never Akahu's own message, which can echo a token.
    expect(JSON.stringify(logged)).not.toContain('Unauthorized')
    for (const token of Object.values(SECRETS)) expect(JSON.stringify(logged)).not.toContain(token)
  })

  it('says nothing ran when no Account is linked to Akahu, and contacts no one', async () => {
    stubAkahu(() => asJson({}))
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = NULL').run()

    const res = await runNow({ secrets: SECRETS })

    expect(await res.json()).toEqual({ ran: false, success: false, pending: null, accounts: [] })
    expect(calls).toEqual([])
  })

  it('answers Not set up with the Akahu tokens unset, and contacts no one', async () => {
    stubAkahu(() => asJson({}))

    const res = await runNow()

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Not set up', feature: 'akahu-sync' })
    expect(calls).toEqual([])
    expect(await rowCount()).toBe(0)
  })

  it('refuses a Member, whether or not Sync is set up, and contacts no one', async () => {
    stubAkahu(() => asJson({}))

    for (const secrets of [undefined, SECRETS]) {
      const res = await runNow({ role: 'member', secrets })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Read-only' })
    }
    expect(calls).toEqual([])
    expect(await rowCount()).toBe(0)
  })

  it('refuses a body with anything in it', async () => {
    stubAkahu(() => asJson({}))

    const res = await runNow({ body: { accountId }, secrets: SECRETS })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: '' })
    expect(calls).toEqual([])
  })

  // ADR 0013: two runs may overlap and nothing stops them, because the upsert on `akahu_id` means a repeat updates the row it
  // already wrote. Two runs back to back is as close as a test can get to that, and it is the case the ADR rests on.
  it('writes no duplicate when it is run again over the same window', async () => {
    stubAkahu(() => asJson({ items: [transaction('trans_0000000000000000001')], cursor: { next: null } }))

    await runNow({ secrets: SECRETS })
    const second = await runNow({ secrets: SECRETS })

    expect(await second.json()).toMatchObject({ success: true, accounts: [{ accountId, complete: true }] })
    expect(await rowCount()).toBe(1)
  })
})
