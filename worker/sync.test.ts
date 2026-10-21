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
  // an Account instead. Reading the Accounts costs one query, so this many fit in a run:
  const ACCOUNTS_PER_RUN = Math.floor((MAX_QUERIES - 1) / QUERIES_PER_ACCOUNT)

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

  // A household of five linked Accounts is one Sync, in the 50 queries one invocation gets (ADR 0004), with the worst case for each
  // Account: Transactions to write, the withdrawn ones to remove, and the details Akahu lists.
  it('syncs five linked Accounts in one run, inside the invocation’s 50 queries', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    const linked = [LINKED, OTHER]
    for (let i = 0; i < 3; i++) {
      linked.push(`acc_spare00000000000000${i}`)
      await account(`Spare ${i}`, `99-9999-9999999-1${i}`, { akahu: linked[linked.length - 1], cutover: '2026-10-01' })
    }
    accountsAnswer = () => asJson({ items: linked.map((_id) => ({ _id, name: 'EXAMPLE' })) })
    stubAkahu((call) => {
      const _account = new URL(call.url).pathname.split('/')[3]
      return onePage([transaction({ _id: `trans_${_account}`, _account })])
    })
    const { ops, DB } = countedDb()

    await runSync({ ...SECRETS, DB })

    expect(calls).toHaveLength(5)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE akahu_synced_at IS NOT NULL').first<{ n: number }>())!.n).toBe(5)
    expect(logged.join(' ')).toContain('sync.done')
    expect(logged.join(' ')).not.toContain('sync.account.no-budget')
    // The Accounts read, then 8 for each Account: the Transaction ID read and the 7 statements of its batch.
    expect(ops.d1).toBe(1 + 5 * (QUERIES_PER_ACCOUNT - 1))
    expect(ops.d1).toBeLessThanOrEqual(MAX_QUERIES)
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
