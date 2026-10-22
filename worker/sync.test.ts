import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AKAHU_API, MAX_PAGES } from './akahu'
import worker from './index'
import { toCents } from './akahu-details'
import { hasBankTime, MAX_QUERIES, QUERIES_PER_ACCOUNT, RECHECK_DAYS, SYNC_CRON, windowStart } from './sync'

// Seam 1: the daily Sync cron through the Worker's exported handler, with Akahu faked at `fetch`, so nothing here reaches
// Akahu. What is checked is what the ticket promises: only linked Accounts are stored, a re-run never duplicates, the window
// starts where it should, every field Akahu gives is kept, a Bank Time is kept only when the bank supplied one, and a run that
// any Account fails in is not a success.

// Deliberately recognisable fakes: a leak into a response or a log line is then obvious. Not real tokens.
const APP_TOKEN = 'app_token_SECRET_VALUE_1'
const USER_TOKEN = 'user_token_SECRET_VALUE_2'
const SECRETS = { AKAHU_APP_TOKEN: APP_TOKEN, AKAHU_USER_TOKEN: USER_TOKEN }

const LINKED = 'acc_linked000000000000001'
const OTHER = 'acc_other0000000000000002'

type Call = { url: string; headers: Headers }
// The Transactions requests, which most tests count; the one request for the Accounts' own details is `accountCalls`.
let calls: Call[] = []
let accountCalls: Call[] = []
/** What Akahu answers to GET /accounts. Nothing, unless a test says: most only look at Transactions. */
let accountsAnswer: () => Response = () => asJson({ items: [] })
let logged: string[] = []

const asJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const stubAkahu = (respond: (call: Call) => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init)
    const call = { url: request.url, headers: request.headers }
    if (new URL(request.url).pathname === '/v1/accounts') {
      accountCalls.push(call)
      return accountsAnswer()
    }
    calls.push(call)
    return respond(call)
  })

/** One Akahu Transaction, with only the fields a test cares about spelled out. */
const transaction = (over: Record<string, unknown> = {}) => ({
  _id: 'trans_0000000000000000001',
  _account: LINKED,
  date: '2026-10-15T00:00:00.000Z',
  created_at: '2026-10-15T20:05:00.000Z',
  description: 'COUNTDOWN ORMISTON',
  amount: -42.5,
  type: 'EFTPOS',
  ...over,
})

const onePage = (items: unknown[]) => asJson({ items, cursor: { next: null } })

let accountId = 0
let otherAccountId = 0

async function account(name: string, number: string, over: { akahu?: string | null; cutover?: string | null; synced?: string | null } = {}) {
  const { meta } = await env.DB.prepare('INSERT INTO accounts (account_number, name, akahu_account_id, cutover_date, akahu_synced_at) VALUES (?, ?, ?, ?, ?)')
    .bind(number, name, over.akahu ?? null, over.cutover ?? null, over.synced ?? null)
    .run()
  return meta.last_row_id
}

const rows = async () =>
  (
    await env.DB.prepare(
      `SELECT account_id, date, amount_cents, description, bank_memo, bank_type, bank_reference, source, akahu_id, merchant,
              bank_counterparty_account, bank_card_suffix, bank_particulars, bank_payment_code, akahu_date_raw, has_bank_time, akahu_first_seen_at
       FROM transactions ORDER BY id`,
    ).all()
  ).results

const syncedAt = async (id: number) => (await env.DB.prepare('SELECT akahu_synced_at FROM accounts WHERE id = ?').bind(id).first<{ akahu_synced_at: string | null }>())!.akahu_synced_at

/** Runs the Sync cron with the secrets set, which is why this goes through `worker.scheduled` with an env of its own. */
async function runSync(secrets: Partial<Env> = SECRETS, cron = SYNC_CRON) {
  const controller = createScheduledController({ scheduledTime: new Date('2026-10-20T18:00:00Z'), cron })
  await worker.scheduled!(controller, { ...env, AKAHU_APP_TOKEN: undefined, AKAHU_USER_TOKEN: undefined, ...secrets } as never)
}

beforeEach(async () => {
  calls = []
  accountCalls = []
  accountsAnswer = () => asJson({ items: [] })
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
  await env.DB.prepare('DELETE FROM transactions').run()
  await env.DB.prepare('DELETE FROM accounts').run()
  accountId = await account('Everyday', '99-9999-9999999-01', { akahu: LINKED, cutover: '2026-10-01' })
  otherAccountId = await account('Savings', '99-9999-9999999-02')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the Sync window', () => {
  it('starts at the Cutover Date when the Account has never synced', () => {
    expect(windowStart({ cutover_date: '2026-10-01', akahu_synced_at: null })).toEqual({ kind: 'from', date: '2026-10-01' })
  })

  it(`re-checks the ${RECHECK_DAYS} days before the last success when that is later than the Cutover Date`, () => {
    expect(windowStart({ cutover_date: '2026-01-01', akahu_synced_at: '2026-10-20T18:00:00.000Z' })).toEqual({ kind: 'from', date: '2026-10-07' })
  })

  it('never starts before the Cutover Date, which an Import owns up to', () => {
    expect(windowStart({ cutover_date: '2026-10-15', akahu_synced_at: '2026-10-20T18:00:00.000Z' })).toEqual({ kind: 'from', date: '2026-10-15' })
  })

  it('lets the re-check decide when it is later than the Cutover Date', () => {
    expect(windowStart({ cutover_date: '2026-10-01', akahu_synced_at: '2026-10-20T18:00:00.000Z' })).toEqual({ kind: 'from', date: '2026-10-07' })
  })

  // An Account is imported first and linked to Akahu after, so this is one that was linked before that was done.
  it('skips an Account with no Cutover Date, rather than asking Akahu for everything', () => {
    expect(windowStart({ cutover_date: null, akahu_synced_at: null })).toEqual({ kind: 'skip' })
  })

  it('re-checks from the last success once it has one, Cutover Date or not', () => {
    expect(windowStart({ cutover_date: null, akahu_synced_at: '2026-10-20T18:00:00.000Z' })).toEqual({ kind: 'from', date: '2026-10-07' })
  })
})

describe('reading one Transaction', () => {
  it('keeps dollars as integer cents, without binary-float drift', () => {
    expect(toCents(-42.5)).toBe(-4250)
    expect(toCents(12.34)).toBe(1234)
    expect(toCents(-0.07)).toBe(-7)
  })

  // Neither midnight is a time the bank meant, and which one Akahu uses for a date-only Transaction is not stated. These are NZ
  // banks reporting NZ dates, so NZ midnight is read as a placeholder as much as UTC midnight is.
  it('reads midnight UTC as a bank that supplied no time', () => {
    expect(hasBankTime('2026-10-15T00:00:00.000Z')).toBe(false)
  })

  it('reads midnight in NZ as a bank that supplied no time, in both NZDT and NZST', () => {
    // 2026-10-16 began at 11:00 UTC on the 15th (NZDT, UTC+13); 2026-06-16 began at 12:00 UTC on the 15th (NZST, UTC+12).
    expect(hasBankTime('2026-10-15T11:00:00.000Z')).toBe(false)
    expect(hasBankTime('2026-06-15T12:00:00.000Z')).toBe(false)
  })

  it('keeps a time that is neither midnight', () => {
    expect(hasBankTime('2026-10-15T09:41:00.000Z')).toBe(true)
    expect(hasBankTime('2026-10-15T11:00:00.001Z')).toBe(true)
  })
})

describe('the daily Sync', () => {
  it('does nothing at all without both Akahu tokens', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync({ AKAHU_APP_TOKEN: APP_TOKEN })
    expect(calls).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('does nothing when no Account is linked', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = NULL').run()
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect(calls).toEqual([])
  })

  it('asks Akahu only for the linked Account, with both tokens in headers', async () => {
    stubAkahu(() => onePage([]))
    await runSync()
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${AKAHU_API}/accounts/${LINKED}/transactions`)
    expect(calls[0]!.headers.get('Authorization')).toBe(`Bearer ${USER_TOKEN}`)
    expect(calls[0]!.headers.get('X-Akahu-Id')).toBe(APP_TOKEN)
  })

  it("asks from just before the Cutover Date's NZ midnight, because Akahu's start is exclusive", async () => {
    stubAkahu(() => onePage([]))
    await runSync()
    const start = new URL(calls[0]!.url).searchParams.get('start')!
    // 2026-10-01 began at 11:00 UTC on 30 September (NZDT, UTC+13); one millisecond before that is the exclusive bound.
    expect(start).toBe('2026-09-30T10:59:59.999Z')
  })

  it('stores every field Akahu gives, on the linked Account', async () => {
    stubAkahu(() =>
      onePage([
        transaction({
          merchant: { name: 'Countdown' },
          meta: { particulars: 'GROCERIES', code: 'WEEKLY', reference: 'REF42', other_account: '99-9999-9999999-09', card_suffix: '1234' },
        }),
      ]),
    )
    await runSync()
    expect(await rows()).toEqual([
      {
        account_id: accountId,
        date: '2026-10-15',
        amount_cents: -4250,
        // The merchant Akahu recognised is what the list shows; the bank's own words are kept beside it.
        description: 'Countdown',
        bank_memo: 'COUNTDOWN ORMISTON',
        bank_type: 'EFTPOS',
        bank_reference: 'REF42',
        source: 'sync',
        akahu_id: 'trans_0000000000000000001',
        merchant: 'Countdown',
        bank_counterparty_account: '99-9999-9999999-09',
        bank_card_suffix: '1234',
        bank_particulars: 'GROCERIES',
        bank_payment_code: 'WEEKLY',
        akahu_date_raw: '2026-10-15T00:00:00.000Z',
        has_bank_time: 0,
        akahu_first_seen_at: '2026-10-15T20:05:00.000Z',
      },
    ])
  })

  it('falls back to the bank description when Akahu recognised no merchant', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect((await rows())[0]).toMatchObject({ description: 'COUNTDOWN ORMISTON', merchant: null })
  })

  it('keeps a Bank Time only when the bank supplied one', async () => {
    stubAkahu(() => onePage([transaction({ date: '2026-10-15T09:41:00.000Z' })]))
    await runSync()
    expect((await rows())[0]).toMatchObject({ has_bank_time: 1, akahu_date_raw: '2026-10-15T09:41:00.000Z' })
  })

  it('never stores an account that was not linked, even if Akahu returns one', async () => {
    stubAkahu(() => onePage([transaction(), transaction({ _id: 'trans_0000000000000000002', _account: OTHER })]))
    await runSync()
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ akahu_id: 'trans_0000000000000000001', account_id: accountId })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').bind(otherAccountId).first<{ n: number }>()).toEqual({ n: 0 })
  })

  it('re-running never duplicates, and takes up a changed Transaction', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    stubAkahu(() => onePage([transaction({ amount: -50.25, description: 'COUNTDOWN ORMISTON CORRECTED' })]))
    await runSync()
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ amount_cents: -5025, description: 'COUNTDOWN ORMISTON CORRECTED' })
  })

  it('follows the cursor to the last page', async () => {
    stubAkahu((call) =>
      new URL(call.url).searchParams.get('cursor') === null
        ? asJson({ items: [transaction()], cursor: { next: 'page2' } })
        : onePage([transaction({ _id: 'trans_0000000000000000002' })]),
    )
    await runSync()
    expect(calls).toHaveLength(2)
    expect(await rows()).toHaveLength(2)
  })

  it('records that Sync reached the Account, so tomorrow asks for a shorter window', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect(await syncedAt(accountId)).toBe('2026-10-20T18:00:00.000Z')
  })

  // Without the status every failure that is not 401 or 403 reads the same, and a rejected query cannot be told from a timeout.
  it('logs the HTTP status Akahu answered with, and nothing else of the answer', async () => {
    stubAkahu(() => asJson({ message: 'Invalid query: start is required' }, 400))
    await runSync()
    const text = logged.join('\n')
    expect(text).toContain('akahu.unreachable')
    expect(text).toContain('ERR_HTTP_400')
    // Akahu's own words never reach a log: they can echo what was sent.
    expect(text).not.toContain('Invalid query')
  })

  it('leaves the last success alone when Akahu refuses, so the window is asked for again', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_synced_at = ? WHERE id = ?').bind('2026-10-19T18:00:00.000Z', accountId).run()
    stubAkahu(() => asJson({ error: 'nope' }, 401))
    await runSync()
    expect(await syncedAt(accountId)).toBe('2026-10-19T18:00:00.000Z')
    expect(logged.join('\n')).toContain('akahu.refused')
  })

  // Akahu refuses a transactions query with no `start`, so there is nothing to fall back to: the Account waits for a Cutover Date.
  it('skips a linked Account with no Cutover Date, and contacts Akahu not at all', async () => {
    await env.DB.prepare('UPDATE accounts SET cutover_date = NULL WHERE id = ?').bind(accountId).run()
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect(calls).toEqual([])
    expect(logged.join('\n')).toContain('sync.account.no-window')
  })

  it('always sends a start, because Akahu rejects a query without one', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('start')).toBe('2026-09-30T10:59:59.999Z')
    expect(params.get('end')).toBe('2026-10-20T18:00:00.000Z')
  })

  // Once an Account has synced, the re-check decides: 14 days before 21 October NZ is 7 October, later than this Account's
  // Cutover Date of 1 October. The second run therefore asks for less than the first, which asked from the Cutover Date.
  it('asks from the re-check on a second run, which is later than the Cutover Date', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    await runSync()
    expect(new URL(calls[1]!.url).searchParams.get('start')).toBe('2026-10-06T10:59:59.999Z')
  })

  // The Cutover Date is still the floor when it is the later of the two: an Import owns everything before it.
  it('never asks earlier than the Cutover Date, whatever the re-check would reach', async () => {
    await env.DB.prepare("UPDATE accounts SET cutover_date = '2026-10-15' WHERE id = ?").bind(accountId).run()
    stubAkahu(() => onePage([transaction({ date: '2026-10-16T11:00:00.000Z' })]))
    await runSync()
    await runSync()
    expect(new URL(calls[1]!.url).searchParams.get('start')).toBe('2026-10-14T10:59:59.999Z')
  })

  it('stops at the page cap and does not call the run a success', async () => {
    // Every page offers another, so only the cap ends it.
    stubAkahu((call) => asJson({ items: [transaction({ _id: `trans_${new URL(call.url).searchParams.get('cursor') ?? 'first'}` })], cursor: { next: `p${calls.length}` } }))
    await runSync()
    // The run's one request for the Accounts' details comes out of the same budget.
    expect(calls).toHaveLength(MAX_PAGES - 1)
    expect(calls.length + accountCalls.length).toBe(MAX_PAGES)
    expect(await syncedAt(accountId)).toBeNull()
    expect(logged.join('\n')).toContain('sync.account.partial')
  })

  it('runs on the Sync cron and not on the others', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync(SECRETS, '0 16 * * SUN')
    expect(calls).toEqual([])
  })

  // Spec 49: a bank can withdraw a Transaction and re-issue it with a new ID. Each Sync re-checks the window, so what Akahu
  // has stopped returning goes, and the ledger does not end up holding both.
  it('removes a Transaction Akahu no longer returns, and keeps the one that replaced it', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect((await rows()).map((r) => r.akahu_id)).toEqual(['trans_0000000000000000001'])

    // The same money, re-issued under a new ID: the old one is gone from Akahu's answer.
    stubAkahu(() => onePage([transaction({ _id: 'trans_0000000000000000002' })]))
    await runSync()

    expect((await rows()).map((r) => r.akahu_id)).toEqual(['trans_0000000000000000002'])
  })

  it('removes nothing when the run did not finish, because it has not seen the whole window', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    // Every page offers another, so the run stops at the cap having read only part of the window.
    stubAkahu(() => asJson({ items: [transaction({ _id: 'trans_0000000000000000009' })], cursor: { next: 'more' } }))
    await runSync()

    // The first Transaction is still there: not being in a partial answer is not evidence that Akahu withdrew it.
    expect((await rows()).map((r) => r.akahu_id)).toContain('trans_0000000000000000001')
  })

  it('never removes an imported Transaction, whatever Akahu returns', async () => {
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, '2026-10-05', -100, 'EXAMPLE IMPORTED', 'import', 'ID1')").bind(accountId).run()
    stubAkahu(() => onePage([]))
    await runSync()

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ source: 'import' })
  })

  it('never removes a Synced Transaction from before the window', async () => {
    // Dated before the Cutover Date of 2026-10-01, so outside what Akahu was asked about.
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, akahu_id) VALUES (?, '2026-08-01', -100, 'EXAMPLE OLD SYNC', 'sync', 'trans_0000000000000000008')").bind(accountId).run()
    stubAkahu(() => onePage([]))
    await runSync()

    expect((await rows()).map((r) => r.akahu_id)).toEqual(['trans_0000000000000000008'])
  })

  // The budget is shared across the run, so the Accounts it does not reach must not be left behind every morning.
  it('takes the least recently synced Account first, so one Account cannot starve the others', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ?, akahu_synced_at = ? WHERE id = ?')
      .bind(OTHER, '2026-10-01', '2026-10-19T18:00:00.000Z', otherAccountId)
      .run()
    // id 1 has synced more recently than id 2, so id 2 is asked about first.
    await env.DB.prepare('UPDATE accounts SET akahu_synced_at = ? WHERE id = ?').bind('2026-10-20T06:00:00.000Z', accountId).run()
    stubAkahu(() => onePage([]))
    await runSync()

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([`/v1/accounts/${OTHER}/transactions`, `/v1/accounts/${LINKED}/transactions`])
  })

  // A batch cut off part way would leave an Account's rows written with no Rules, no pairing and no mark, so Sync stops before
  // an Account instead. Reading the Accounts costs one query and dropping old Sync balances another, so this many fit in a run:
  const ACCOUNTS_PER_RUN = Math.floor((MAX_QUERIES - 2) / QUERIES_PER_ACCOUNT)

  it('stops before an Account it has no database budget left for, and does not call the run a success', async () => {
    // One more linked Account than a run can take.
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    for (let i = 0; i < ACCOUNTS_PER_RUN; i++) {
      await account(`Spare ${i}`, `99-9999-9999999-1${i}`, { akahu: `acc_spare00000000000000${i}`, cutover: '2026-10-01' })
    }
    stubAkahu(() => onePage([]))

    await runSync()

    expect(calls).toHaveLength(ACCOUNTS_PER_RUN)
    const text = logged.join(' ')
    expect(text).toContain('sync.account.no-budget')
    expect(text).toContain('sync.incomplete')
  })

  it('reaches the Accounts it skipped on the next run, because they are the stalest', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    for (let i = 0; i < ACCOUNTS_PER_RUN; i++) {
      await account(`Spare ${i}`, `99-9999-9999999-1${i}`, { akahu: `acc_spare00000000000000${i}`, cutover: '2026-10-01' })
    }
    stubAkahu(() => onePage([]))

    await runSync()
    const first = new Set(calls.map((call) => new URL(call.url).pathname))
    calls.length = 0
    await runSync()
    const second = calls.map((call) => new URL(call.url).pathname)

    // Nothing the first run finished is asked about again before the ones it never reached.
    expect(second.some((path) => !first.has(path))).toBe(true)
    expect(second[0]).not.toBe([...first][0])
  })

  it('puts neither token in a log line', async () => {
    stubAkahu(() => asJson('not what Akahu says', 200))
    await runSync()
    const text = logged.join('\n')
    expect(text).not.toContain(APP_TOKEN)
    expect(text).not.toContain(USER_TOKEN)
    expect(text).toContain('akahu.unreadable')
  })

  /** The D1 binding with every query counted: a statement run alone is one, and each statement of a batch is one (D1 bills them so). */
  const countedDb = () => {
    const ops = { d1: 0 }
    const statement = (s: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(s, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as (...args: unknown[]) => unknown
          if (prop === 'bind') return (...args: unknown[]) => statement(value.apply(target, args) as D1PreparedStatement)
          if (prop === 'all' || prop === 'first' || prop === 'run' || prop === 'raw') return (...args: unknown[]) => (ops.d1++, value.apply(target, args))
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') return (query: string) => statement(target.prepare(query))
        if (prop === 'batch') return (statements: D1PreparedStatement[]) => ((ops.d1 += statements.length), target.batch(statements))
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ops, DB }
  }

  // A household of four linked Accounts is one Sync, in the 50 queries one invocation gets (ADR 0004), with the worst case for each
  // Account: Transactions to write, the withdrawn ones to remove, the details Akahu lists and a balance to record and check.
  it('syncs four linked Accounts in one run, inside the invocation’s 50 queries', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    const linked = [LINKED, OTHER]
    for (let i = 0; i < 2; i++) {
      linked.push(`acc_spare00000000000000${i}`)
      await account(`Spare ${i}`, `99-9999-9999999-1${i}`, { akahu: linked[linked.length - 1], cutover: '2026-10-01' })
    }
    const refreshed = '2026-10-21T02:46:00.000Z'
    accountsAnswer = () => asJson({ items: linked.map((_id) => ({ _id, name: 'EXAMPLE', balance: { currency: 'NZD', current: 707.17 }, refreshed: { balance: refreshed, transactions: refreshed } })) })
    stubAkahu((call) => {
      const _account = new URL(call.url).pathname.split('/')[3]
      return onePage([transaction({ _id: `trans_${_account}`, _account })])
    })
    const { ops, DB } = countedDb()

    await runSync({ ...SECRETS, DB })

    expect(calls).toHaveLength(4)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE akahu_synced_at IS NOT NULL').first<{ n: number }>())!.n).toBe(4)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM balance_checks WHERE source = 'sync'").first<{ n: number }>())!.n).toBe(4)
    expect(logged.join(' ')).toContain('sync.done')
    expect(logged.join(' ')).not.toContain('sync.account.no-budget')
    // The Accounts read, then 11 for each Account: the Transaction ID read, the 8 statements of its batch and the Balance Check's read
    // and write; then the one that drops old Sync balances.
    expect(ops.d1).toBe(1 + 4 * QUERIES_PER_ACCOUNT + 1)
    expect(ops.d1).toBe(MAX_QUERIES)
    expect(MAX_QUERIES).toBeLessThan(50)
  })

  // Sync has the invocation to itself on its own cron. The backup and the Rules re-run are carried on by the other daily cron,
  // which is why the two crons never both spend the 50 queries.
  it('on the Sync cron does nothing but Sync, and the other daily cron carries the backup and the Rules re-run on', async () => {
    const sync = countedDb()
    await runSync({ DB: sync.DB } as Partial<Env>, SYNC_CRON)
    expect(sync.ops.d1).toBe(0) // no tokens, so Sync reads nothing, and neither the backup nor the re-run looks

    const carryOn = countedDb()
    await runSync({ DB: carryOn.DB } as Partial<Env>, '0 15 * * *')
    expect(carryOn.ops.d1).toBeGreaterThanOrEqual(1) // at least the look for a running Rules re-run (backup.test.ts carries a backup on from this cron)
  })
})

// Ticket 42: everything Akahu says about the Account itself is kept on each Sync, and shown on the Accounts screen.
describe('the Account details Sync keeps', () => {
  const akahuAccountBody = (over: Record<string, unknown> = {}) => ({
    _id: LINKED,
    connection: { _id: 'conn_example0000000000001', name: 'Example Bank', logo: 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001', connection_type: 'official' },
    name: 'EVERYDAY EXAMPLE',
    formatted_account: '99-9999-9999999-01',
    status: 'ACTIVE',
    type: 'CHECKING',
    attributes: ['PAYMENT_TO', 'TRANSACTIONS'],
    balance: { currency: 'NZD', current: 707.17, available: 700.1 },
    refreshed: { balance: '2026-10-21T02:46:00.000Z', meta: '2026-10-21T02:47:00.000Z', transactions: '2026-10-21T02:48:00.000Z' },
    ...over,
  })
  const listing = (...items: unknown[]) => {
    accountsAnswer = () => asJson({ items })
  }
  const details = async (id: number) => (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Record<string, unknown>>())!
  const stored = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('akahu_') && key !== 'akahu_account_id' && key !== 'akahu_synced_at'))

  it('stores every field on the linked Account, and the balance as integer cents', async () => {
    stubAkahu(() => onePage([]))
    listing(akahuAccountBody(), akahuAccountBody({ _id: OTHER, name: 'NOT LINKED' }))
    await runSync()
    expect(stored(await details(accountId))).toEqual({
      akahu_name: 'EVERYDAY EXAMPLE',
      akahu_formatted_account: '99-9999-9999999-01',
      akahu_status: 'ACTIVE',
      akahu_type: 'CHECKING',
      akahu_attributes: '["PAYMENT_TO","TRANSACTIONS"]',
      akahu_connection_id: 'conn_example0000000000001',
      akahu_connection_name: 'Example Bank',
      akahu_connection_logo: 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001',
      akahu_connection_type: 'official',
      akahu_balance_currency: 'NZD',
      akahu_balance_current_cents: 70717,
      akahu_balance_available_cents: 70010,
      akahu_refreshed_balance_at: '2026-10-21T02:46:00.000Z',
      akahu_refreshed_meta_at: '2026-10-21T02:47:00.000Z',
      akahu_refreshed_transactions_at: '2026-10-21T02:48:00.000Z',
    })
  })

  it('stores nothing on an Account that is not linked, whatever else Akahu lists', async () => {
    stubAkahu(() => onePage([]))
    listing(akahuAccountBody(), akahuAccountBody({ _id: OTHER, name: 'NOT LINKED' }))
    await runSync()
    expect(Object.values(stored(await details(otherAccountId))).every((value) => value === null)).toBe(true)
  })

  it('clears a field Akahu stops sending, rather than leaving it stale', async () => {
    stubAkahu(() => onePage([]))
    listing(akahuAccountBody())
    await runSync()
    const { balance: _balance, refreshed: _refreshed, ...fewer } = akahuAccountBody()
    listing({ ...fewer, connection: { _id: 'conn_example0000000000001', name: 'Example Bank' }, name: 'RENAMED' })
    await runSync()
    expect(stored(await details(accountId))).toMatchObject({
      akahu_name: 'RENAMED',
      akahu_connection_logo: null,
      akahu_connection_type: null,
      akahu_balance_currency: null,
      akahu_balance_current_cents: null,
      akahu_balance_available_cents: null,
      akahu_refreshed_balance_at: null,
      akahu_refreshed_meta_at: null,
      akahu_refreshed_transactions_at: null,
    })
  })

  it('asks for the Akahu accounts once for the whole run, whatever the number of Accounts', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    stubAkahu(() => onePage([]))
    listing(akahuAccountBody(), akahuAccountBody({ _id: OTHER, name: 'SAVINGS EXAMPLE' }))
    await runSync()
    expect(accountCalls).toHaveLength(1)
    const url = new URL(accountCalls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${AKAHU_API}/accounts`)
    expect(accountCalls[0]!.headers.get('Authorization')).toBe(`Bearer ${USER_TOKEN}`)
    expect(calls).toHaveLength(2)
    expect((await details(accountId)).akahu_name).toBe('EVERYDAY EXAMPLE')
    expect((await details(otherAccountId)).akahu_name).toBe('SAVINGS EXAMPLE')
  })

  it('does not ask for them when it has no Account to sync', async () => {
    await env.DB.prepare('UPDATE accounts SET cutover_date = NULL').run()
    stubAkahu(() => onePage([]))
    await runSync()
    expect(accountCalls).toEqual([])
  })

  it('stores what Akahu has when the account lacks a status, type and connection', async () => {
    stubAkahu(() => onePage([]))
    const { status: _status, type: _type, connection: _connection, ...odd } = akahuAccountBody()
    listing(odd)
    await runSync()
    expect(stored(await details(accountId))).toMatchObject({ akahu_name: 'EVERYDAY EXAMPLE', akahu_status: null, akahu_type: null, akahu_connection_name: null, akahu_balance_current_cents: 70717 })
  })

  it('stores them even when the Transactions failed, and the Account stays unfinished', async () => {
    stubAkahu(() => asJson({}, 500))
    listing(akahuAccountBody())
    await runSync()
    expect(await syncedAt(accountId)).toBeNull()
    expect((await details(accountId)).akahu_name).toBe('EVERYDAY EXAMPLE')
  })

  it('does not store them for a failed Account whose link changed meanwhile', async () => {
    stubAkahu(async () => {
      await env.DB.prepare('UPDATE accounts SET akahu_account_id = ? WHERE id = ?').bind(OTHER, accountId).run()
      return asJson({}, 500)
    })
    listing(akahuAccountBody())
    await runSync()
    expect((await details(accountId)).akahu_name).toBeNull()
  })

  it('does not give an Account the details of an Akahu account it was linked to when the run began', async () => {
    // The Admin relinks the Account while Sync is reading its Transactions, after the details were read.
    stubAkahu(async () => {
      await env.DB.prepare('UPDATE accounts SET akahu_account_id = ? WHERE id = ?').bind(OTHER, accountId).run()
      return onePage([])
    })
    listing(akahuAccountBody())
    await runSync()
    expect((await details(accountId)).akahu_name).toBeNull()
  })

  describe('when Akahu cannot say', () => {
    const first = async () => {
      stubAkahu(() => onePage([]))
      listing(akahuAccountBody())
      await runSync()
      return stored(await details(accountId))
    }

    for (const [what, answer] of [
      ['refuses', () => asJson({}, 401)],
      ['fails', () => asJson({}, 500)],
      ['answers with something unreadable', () => asJson({ items: [{ _id: LINKED }] })],
    ] as const) {
      it(`syncs the Transactions as ever, and keeps what it had, when Akahu ${what} the details`, async () => {
        const before = await first()
        expect(before.akahu_name).toBe('EVERYDAY EXAMPLE')
        stubAkahu(() => onePage([transaction()]))
        accountsAnswer = answer
        await env.DB.prepare('UPDATE accounts SET akahu_synced_at = NULL WHERE id = ?').bind(accountId).run()
        await runSync()
        expect(await rows()).toHaveLength(1)
        expect(await syncedAt(accountId)).toBe('2026-10-20T18:00:00.000Z')
        expect(stored(await details(accountId))).toEqual(before)
      })
    }

    it('keeps what it had when the answer has no such account', async () => {
      const before = await first()
      listing(akahuAccountBody({ _id: OTHER }))
      await runSync()
      expect(stored(await details(accountId))).toEqual(before)
    })
  })
})

// Ticket 43: every other field Akahu sends for a Transaction is kept. All of it is made up (conn_example…, nzfcc_example…).
describe('the rest of an Akahu Transaction', () => {
  const full = {
    category: { _id: 'nzfcc_example0000000001', name: 'Example category', groups: { personal_finance: { _id: 'group_example00000001', name: 'Example group' } } },
    balance: 707.17,
    hash: 'acc_example0000000000001-0123456789abcdef',
    updated_at: '2026-10-16T01:02:03.000Z',
    posted_date: '2026-10-15T11:00:00.000Z',
    _connection: 'conn_example0000000000001',
  }
  const kept = async () =>
    (
      await env.DB.prepare(
        `SELECT akahu_category_id, akahu_category_name, akahu_category_group_id, akahu_category_group_name, akahu_balance_cents, akahu_hash,
                akahu_updated_at, akahu_posted_date, akahu_connection_id, bank_time_from_memo FROM transactions`,
      ).all()
    ).results
  const NOTHING = {
    akahu_category_id: null,
    akahu_category_name: null,
    akahu_category_group_id: null,
    akahu_category_group_name: null,
    akahu_balance_cents: null,
    akahu_hash: null,
    akahu_updated_at: null,
    akahu_posted_date: null,
    akahu_connection_id: null,
    bank_time_from_memo: null,
  }
  const connection = (name: string | null) => {
    accountsAnswer = () => asJson({ items: [{ _id: LINKED, name: 'EVERYDAY EXAMPLE', ...(name === null ? {} : { connection: { name } }) }] })
  }

  it('stores the category, balance, hash, update and posted dates and connection, and the balance as integer cents', async () => {
    stubAkahu(() => onePage([transaction(full)]))
    await runSync()
    expect(await kept()).toEqual([
      {
        ...NOTHING,
        akahu_category_id: 'nzfcc_example0000000001',
        akahu_category_name: 'Example category',
        akahu_category_group_id: 'group_example00000001',
        akahu_category_group_name: 'Example group',
        akahu_balance_cents: 70717,
        akahu_hash: 'acc_example0000000000001-0123456789abcdef',
        akahu_updated_at: '2026-10-16T01:02:03.000Z',
        akahu_posted_date: '2026-10-15T11:00:00.000Z',
        akahu_connection_id: 'conn_example0000000000001',
      },
    ])
  })

  it('takes a row with none of the optional fields as ordinary, and keeps them as not known', async () => {
    stubAkahu(() => onePage([transaction()]))
    await runSync()
    expect(await kept()).toEqual([NOTHING])
    expect(logged.join(' ')).toContain('sync.done')
  })

  // A strict parse would fail the whole page, and the Account with it (as ticket 42's picker found).
  it.each([
    ['a category with no group', { category: { _id: 'nzfcc_example0000000001', name: 'Example category' } }],
    ['a category with a group that is empty', { category: { _id: 'nzfcc_example0000000001', name: 'Example category', groups: {} } }],
    ['a category with only an ID', { category: { _id: 'nzfcc_example0000000001' } }],
    ['an empty category', { category: {} }],
    ['a field Fernledger does not know', { somethingNew: { nested: true } }],
  ])('still stores the page when a row has %s', async (_, over) => {
    stubAkahu(() => onePage([transaction(over), transaction({ _id: 'trans_0000000000000000002' })]))
    await runSync()
    expect(await rows()).toHaveLength(2)
    expect(logged.join(' ')).toContain('sync.done')
  })

  it('stores a balance of zero, which is a balance and not an absent one', async () => {
    stubAkahu(() => onePage([transaction({ balance: 0 })]))
    await runSync()
    expect((await kept())[0]).toMatchObject({ akahu_balance_cents: 0 })
  })

  it('updates all of them when Akahu has since changed the row, and clears what it stops sending', async () => {
    stubAkahu(() => onePage([transaction(full)]))
    await runSync()
    stubAkahu(() =>
      onePage([
        transaction({
          category: { _id: 'nzfcc_example0000000002', name: 'Another category' },
          balance: 650.5,
          hash: 'acc_example0000000000001-fedcba9876543210',
          updated_at: '2026-10-17T00:00:00.000Z',
          _connection: 'conn_example0000000000002',
        }),
      ]),
    )
    await runSync()
    expect(await kept()).toEqual([
      {
        ...NOTHING,
        akahu_category_id: 'nzfcc_example0000000002',
        akahu_category_name: 'Another category',
        akahu_balance_cents: 65050,
        akahu_hash: 'acc_example0000000000001-fedcba9876543210',
        akahu_updated_at: '2026-10-17T00:00:00.000Z',
        akahu_connection_id: 'conn_example0000000000002',
      },
    ])
  })

  describe('the EFTPOS time in a Kiwibank description', () => {
    const eftpos = (description: string, over: Record<string, unknown> = {}) => transaction({ description, date: '2026-10-15T11:00:00.000Z', ...over })
    const bankTime = async () => (await kept())[0]!.bank_time_from_memo

    it('is read as an NZ time, and the description and memo stay as the bank wrote them', async () => {
      connection('Kiwibank')
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-12:07')]))
      await runSync()
      // 11:00 UTC is NZ midnight at the start of the 16th, on summer time (UTC+13), so 12:07 is 23:07 UTC the day before.
      expect(await bankTime()).toBe('2026-10-15T23:07:00.000Z')
      expect((await rows())[0]).toMatchObject({ description: 'POS W/D Example Store-12:07', bank_memo: 'POS W/D Example Store-12:07', has_bank_time: 0, akahu_date_raw: '2026-10-15T11:00:00.000Z' })
    })

    it.each([
      ['has no time', 'DIRECT DEBIT Example Energy'],
      ['has an impossible one', 'POS W/D Example Store-25:99'],
      ['has no colon', 'POS W/D Example Store-1207'],
      ['has no dash', 'POS W/D Example Store 12:07'],
      ['has one mid-string', 'POS W/D Example-12:07 Store'],
    ])('is not read when the description %s', async (_, description) => {
      connection('Kiwibank')
      stubAkahu(() => onePage([eftpos(description)]))
      await runSync()
      expect(await bankTime()).toBeNull()
      expect((await rows())[0]).toMatchObject({ bank_memo: description })
    })

    it('is not read from another bank, even in the same words', async () => {
      connection('Example Bank')
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-12:07')]))
      await runSync()
      expect(await bankTime()).toBeNull()
    })

    it('is not read when the bank is not known', async () => {
      connection(null)
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-12:07')]))
      await runSync()
      expect(await bankTime()).toBeNull()
    })

    it('uses the bank an earlier Sync learned when this one cannot say', async () => {
      connection('Kiwibank')
      stubAkahu(() => onePage([]))
      await runSync()
      accountsAnswer = () => asJson({}, 500)
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-12:07')]))
      await env.DB.prepare('UPDATE accounts SET akahu_synced_at = NULL WHERE id = ?').bind(accountId).run()
      await runSync()
      expect(await bankTime()).toBe('2026-10-15T23:07:00.000Z')
    })

    it('reads a clock time NZ never had as no time at all', async () => {
      connection('Kiwibank')
      // 2026-09-27 is the day clocks went forward: 02:30 never happened.
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-02:30', { date: '2026-09-26T12:00:00.000Z' })]))
      await runSync()
      expect(await bankTime()).toBeNull()
    })
  })
})

// Ticket 30, spec 61: after a Sync that finished, Akahu's balance is recorded as the Account's bank balance and checked.
describe('the Balance Check after a Sync', () => {
  const READ = '2026-10-21T02:46:00.000Z' // 15:46 on 21 October in NZ
  const reading = (over: Record<string, unknown> = {}) => ({
    _id: LINKED,
    name: 'EVERYDAY EXAMPLE',
    balance: { currency: 'NZD', current: 707.17 },
    refreshed: { balance: READ, meta: READ, transactions: READ },
    ...over,
  })
  const listing = (...items: unknown[]) => {
    accountsAnswer = () => asJson({ items })
  }
  type Balance = { date: string; cents: number; source: string; status: string; since: string | null; difference: number | null }
  const bankBalances = async () =>
    (
      await env.DB.prepare(
        'SELECT as_of_date AS date, bank_cents AS cents, source, status, checked_against AS since, difference_cents AS difference FROM balance_checks ORDER BY as_of_date, source',
      ).all<Balance>()
    ).results
  const spent = (id: string, date: string, amount: number) => transaction({ _id: id, date, amount })

  it("records Akahu's balance as of the NZ day Akahu read the bank, alone at first because nothing is before it", async () => {
    stubAkahu(() => onePage([transaction({ amount: -42.5 })]))
    listing(reading())
    await runSync()
    expect(await bankBalances()).toEqual([{ date: '2026-10-21', cents: 70_717, source: 'sync', status: 'alone', since: null, difference: null }])
  })

  it('counts the Transactions the Sync saved, so one dated that day is in the balance', async () => {
    stubAkahu(() => onePage([spent('trans_a', '2026-10-21T00:00:00.000Z', -42.5)]))
    listing(reading())
    await runSync()
    const row = await env.DB.prepare('SELECT through_transaction_id AS id FROM balance_checks').first<{ id: number }>()
    expect(row!.id).toBe((await env.DB.prepare('SELECT MAX(id) AS id FROM transactions').first<{ id: number }>())!.id)
  })

  it('checks the next balance against the one before: matched when the Transactions since explain the change', async () => {
    const first = spent('trans_a', '2026-10-15T00:00:00.000Z', -42.5)
    stubAkahu(() => onePage([first]))
    listing(reading())
    await runSync()
    // The next day: $10.00 spent, and Akahu's balance is $10.00 lower.
    const next = '2026-10-22T02:46:00.000Z'
    stubAkahu(() => onePage([first, spent('trans_b', '2026-10-21T20:00:00.000Z', -10)]))
    listing(reading({ balance: { currency: 'NZD', current: 697.17 }, refreshed: { balance: next, transactions: next } }))
    await runSync()
    expect(await bankBalances()).toMatchObject([
      { date: '2026-10-21', status: 'alone' },
      { date: '2026-10-22', cents: 69_717, status: 'matched', since: '2026-10-21', difference: 0 },
    ])
  })

  it('reports a difference, dated from the balance before, when a Transaction is missing', async () => {
    stubAkahu(() => onePage([spent('trans_a', '2026-10-15T00:00:00.000Z', -42.5)]))
    listing(reading())
    await runSync()
    // Akahu's balance is $25.00 lower, but no Transaction came with it.
    const next = '2026-10-22T02:46:00.000Z'
    listing(reading({ balance: { currency: 'NZD', current: 682.17 }, refreshed: { balance: next, transactions: next } }))
    await runSync()
    expect(await bankBalances()).toMatchObject([{ status: 'alone' }, { date: '2026-10-22', status: 'differs', since: '2026-10-21', difference: -2_500 }])
  })

  it('is not made uncounted by the Cutover Date, which every Akahu balance is after, and sets aside a file balance dated on it', async () => {
    await env.DB.prepare("INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (?, '2026-10-01', 50000, 'import', 0, 'after-cutover')")
      .bind(accountId)
      .run()
    stubAkahu(() => onePage([transaction()]))
    listing(reading())
    await runSync()
    expect(await bankBalances()).toMatchObject([
      { date: '2026-10-01', source: 'import', status: 'after-cutover' },
      { date: '2026-10-21', source: 'sync', status: 'alone' },
    ])
  })

  it("records one balance for one reading, however many Syncs see it, and replaces the day's own", async () => {
    stubAkahu(() => onePage([transaction()]))
    listing(reading())
    await runSync()
    await runSync()
    expect(await bankBalances()).toHaveLength(1)
    // Akahu reads the bank again later the same NZ day: the day's balance is replaced.
    const later = '2026-10-21T08:00:00.000Z'
    listing(reading({ balance: { currency: 'NZD', current: 600 }, refreshed: { balance: later, transactions: later } }))
    await runSync()
    expect(await bankBalances()).toMatchObject([{ date: '2026-10-21', cents: 60_000 }])
  })

  it('records nothing when Akahu sent no balance, or did not list the Account', async () => {
    stubAkahu(() => onePage([transaction()]))
    listing(reading({ balance: undefined }))
    await runSync()
    expect(logged.join('\n')).toContain('sync.balance.no-balance')
    listing(reading({ _id: OTHER }))
    await runSync()
    expect(await bankBalances()).toEqual([])
  })

  it('records nothing when Akahu read the balance and the Transactions at different times', async () => {
    stubAkahu(() => onePage([transaction()]))
    listing(reading({ refreshed: { balance: READ, transactions: '2026-10-21T02:47:00.000Z' } }))
    await runSync()
    expect(await bankBalances()).toEqual([])
    expect(logged.join('\n')).toContain('sync.balance.refreshed-apart')
    expect(await syncedAt(accountId)).not.toBeNull() // the Sync itself is unaffected
  })

  it('records nothing when the Sync did not finish', async () => {
    stubAkahu((call) => asJson({ items: [transaction({ _id: `trans_${new URL(call.url).searchParams.get('cursor') ?? 'first'}` })], cursor: { next: `p${calls.length}` } }))
    listing(reading())
    await runSync()
    expect(await syncedAt(accountId)).toBeNull()
    expect(await bankBalances()).toEqual([])
    expect(logged.join('\n')).toContain('sync.balance.incomplete')
  })

  it('records nothing for an Account whose Transactions Akahu refused', async () => {
    stubAkahu(() => new Response('{}', { status: 401 }))
    listing(reading())
    await runSync()
    expect(await bankBalances()).toEqual([])
  })

  it("drops Sync balances older than 60 days, but never an Account's newest or a file balance", async () => {
    const insert = env.DB.prepare("INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (?, ?, 1, ?, 0, 'alone')")
    await env.DB.batch([
      insert.bind(accountId, '2026-06-01', 'import'),
      insert.bind(accountId, '2026-08-01', 'sync'), // 80 days before the run
      insert.bind(accountId, '2026-09-01', 'sync'),
      insert.bind(otherAccountId, '2026-06-01', 'sync'), // the only one of an Account that is not synced: kept
    ])
    stubAkahu(() => onePage([transaction()]))
    listing(reading())
    await runSync()
    expect((await bankBalances()).map((row) => [row.date, row.source])).toEqual([
      ['2026-06-01', 'import'],
      ['2026-06-01', 'sync'],
      ['2026-09-01', 'sync'],
      ['2026-10-21', 'sync'],
    ])
  })

  it('does not fail the Sync when the check cannot run', async () => {
    stubAkahu(() => onePage([transaction()]))
    listing(reading())
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') return (query: string) => target.prepare(query.includes('WITH daily') ? 'SELECT * FROM no_such_table' : query)
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await runSync({ ...SECRETS, DB: failing })
    expect(await syncedAt(accountId)).not.toBeNull()
    expect(logged.join('\n')).toContain('sync.balance.check-failed')
    expect(await bankBalances()).toHaveLength(1)
  })
})
