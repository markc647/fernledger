import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AKAHU_API, AKAHU_TEXT_LIMIT, boundedText, MAX_PAGES } from './akahu'
import worker from './index'
import { toCents } from './akahu-details'
import { ACCOUNTS_PER_RUN, hasBankTime, MAX_QUERIES, MAX_WINDOW_DAYS, QUERIES_PER_ACCOUNT, RUN_QUERIES, RECHECK_DAYS, syncAll, SYNC_CRON, windowEnd, windowStart } from './sync'
import { nzDayStart } from './nz-time'

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
// The one request a run makes for the Pending Transactions of every Account (worker/pending.ts).
let pendingCalls: Call[] = []
/**
 * What Akahu answers to GET /accounts. By default it lists every Account that is linked, which is what Akahu does for a healthy
 * link: a test that answers with nothing is saying Akahu has stopped listing them, which is a broken Account Link (ticket 29) and
 * no longer a Sync that finished. The tests that mean that say so themselves.
 */
let accountsAnswer: (() => Response | Promise<Response>) | null = null

/** Akahu listing exactly the Accounts this database has linked, with no details beyond the name. */
const listsWhatIsLinked = async () => {
  const { results } = await env.DB.prepare('SELECT akahu_account_id FROM accounts WHERE akahu_account_id IS NOT NULL').all<{ akahu_account_id: string }>()
  return asJson({ items: results.map((row) => ({ _id: row.akahu_account_id, name: 'EXAMPLE' })) })
}
/** What Akahu answers to GET /transactions/pending. Nothing pending, unless a test says. */
let pendingAnswer: () => Response = () => asJson({ items: [] })
let logged: string[] = []

const asJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const stubAkahu = (respond: (call: Call) => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init)
    const call = { url: request.url, headers: request.headers }
    if (new URL(request.url).pathname === '/v1/accounts') {
      accountCalls.push(call)
      return accountsAnswer === null ? listsWhatIsLinked() : accountsAnswer()
    }
    if (new URL(request.url).pathname === '/v1/transactions/pending') {
      pendingCalls.push(call)
      return pendingAnswer()
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

/** The run's own outcome, which the cron handler does not hand back: the Admin's route is what returns it (worker/sync-route.ts). */
const runSyncOutcome = (secrets: Partial<Env> = SECRETS) =>
  syncAll({ ...env, AKAHU_APP_TOKEN: undefined, AKAHU_USER_TOKEN: undefined, ...secrets } as never, new Date('2026-10-20T18:00:00Z'))

beforeEach(async () => {
  calls = []
  accountCalls = []
  pendingCalls = []
  accountsAnswer = null
  pendingAnswer = () => asJson({ items: [] })
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
  await env.DB.prepare('DELETE FROM pending_transactions').run()
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
  it(`reads to now when that is within ${MAX_WINDOW_DAYS} days of where the window starts`, () => {
    const now = new Date('2026-10-20T18:00:00.000Z')
    expect(windowEnd('2026-10-06', now)).toEqual(now)
  })

  it(`reads at most ${MAX_WINDOW_DAYS} days, to NZ midnight, when the window starts longer ago than that`, () => {
    expect(windowEnd('2026-01-01', new Date('2026-10-20T18:00:00.000Z')).toISOString()).toBe(nzDayStart('2026-03-02'))
  })

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

  it('keeps at most AKAHU_TEXT_LIMIT characters of any text, says how many were cut, and keeps text well-formed', async () => {
    // Long enough that, holding "begin", its row would be too long to restore as hex (backup-format.ts).
    const long = 'EXAMPLE begin '.padEnd(50_000, 'X')
    stubAkahu(() => onePage([transaction({ description: long, meta: { reference: 'REF\ud800ONE' } })]))
    await runSync()

    const stored = (await env.DB.prepare('SELECT description, bank_memo, bank_reference FROM transactions WHERE akahu_id IS NOT NULL').first<{ description: string; bank_memo: string; bank_reference: string }>())!
    expect(stored.description).toBe(long.slice(0, AKAHU_TEXT_LIMIT))
    expect(stored.bank_memo).toBe(long.slice(0, AKAHU_TEXT_LIMIT))
    expect(stored.bank_reference).toBe('REF\ufffdONE') // a lone surrogate, which JSON allows, is made well-formed
    expect(logged.join('\n')).toMatch(/"event":"akahu.text-cut","count":1\b/)
    expect(logged.join('\n')).not.toContain('EXAMPLE begin') // the text itself is never logged
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
  // an Account instead. ACCOUNTS_PER_RUN is what fits after the run's own queries (worker/sync.ts).

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
    // Pending money to write as well, which is the run's own worst case: the delete and the insert both run (RUN_QUERIES).
    pendingAnswer = () => asJson({ items: linked.map((_account) => ({ _account, date: '2026-10-20T11:00:00.000Z', description: 'PENDING CAFE', amount: -4.5 })) })
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
    // The Accounts read, then for each Account its Transaction ID read, the 8 statements of its batch and the Balance Check's read and
    // write (11, the worst case this fakes): exactly what MAX_QUERIES counts.
    expect(calls).toHaveLength(ACCOUNTS_PER_RUN)
    expect(ops.d1).toBe(RUN_QUERIES + ACCOUNTS_PER_RUN * QUERIES_PER_ACCOUNT)
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
      // Akahu listed the Account, so its Link is not broken and the last Sync of it did not fail (ticket 29).
      akahu_missing_since: null,
      akahu_last_failure: null,
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
    const { balance: _balance, refreshed: _refreshed, attributes: _attributes, formatted_account: _formatted, ...fewer } = akahuAccountBody()
    listing({ ...fewer, connection: { _id: 'conn_example0000000000001', name: 'Example Bank' }, name: 'RENAMED' })
    await runSync()
    expect(stored(await details(accountId))).toMatchObject({
      akahu_name: 'RENAMED',
      // The two the Accounts screen gained with ticket 42 go back to nothing like the rest, rather than showing what Akahu no longer says.
      akahu_formatted_account: null,
      akahu_attributes: null,
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

    // Akahu answered and did not name the Account, which is the one case that says the Link is broken: the details it stored
    // when Akahu still listed it are kept and nothing of the Account's is cleared (ticket 29, spec 32).
    it('keeps what it had when the answer has no such account, and marks the Link broken', async () => {
      const before = await first()
      listing(akahuAccountBody({ _id: OTHER }))
      await runSync()
      // The cause is recorded with the mark, for the Sync status to name (spec 59), and the details themselves are untouched.
      expect(stored(await details(accountId))).toEqual({ ...before, akahu_missing_since: '2026-10-20T18:00:00.000Z', akahu_last_failure: 'link-broken' })
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

  // Mark, 2026-10-23: nothing is read out of the words the bank wrote. Kiwibank writes the time of an EFTPOS purchase at the end of its
  // description, and it stays there: a Transaction has a time of day only where Akahu's own date carries one.
  describe('the time Kiwibank writes into a description', () => {
    const eftpos = (description: string, over: Record<string, unknown> = {}) => transaction({ description, date: '2026-10-15T11:00:00.000Z', ...over })

    it('is left in the words, and makes no time of day for the Transaction', async () => {
      connection('Kiwibank')
      stubAkahu(() => onePage([eftpos('POS W/D Example Store-12:07')]))
      await runSync()
      expect((await rows())[0]).toMatchObject({
        description: 'POS W/D Example Store-12:07',
        bank_memo: 'POS W/D Example Store-12:07',
        has_bank_time: 0,
        akahu_date_raw: '2026-10-15T11:00:00.000Z',
      })
      // The column 4301 added for the time read out of a description is no longer written (migrations are add-only, ADR 0009).
      expect((await kept())[0]!.bank_time_from_memo).toBeNull()
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
    listing(reading({ refreshed: { balance: READ, transactions: '2026-10-21T03:46:00.000Z' } }))
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

// Pending Transactions, the Account Link Akahu stops returning, and the cause the Sync status names (ticket 29, spec 32, 54, 55, 56, 59).
describe('pending money, a broken Link and why a Sync failed', () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    _account: LINKED,
    date: '2026-10-20T11:00:00.000Z',
    description: 'PENDING CAFE',
    amount: -4.5,
    type: 'EFTPOS',
    ...over,
  })

  const pendingRows = async () =>
    (await env.DB.prepare('SELECT account_id, date, amount_cents, description, bank_type, synced_at FROM pending_transactions ORDER BY id').all()).results

  const accountState = async (id: number) =>
    (await env.DB.prepare('SELECT akahu_missing_since, akahu_last_failure FROM accounts WHERE id = ?').bind(id).first<{ akahu_missing_since: string | null; akahu_last_failure: string | null }>())!

  it('asks Akahu for the pending money once a run, whatever the number of Accounts, and keeps it as cents on the NZ date', async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_account_id = ?, cutover_date = ? WHERE id = ?').bind(OTHER, '2026-10-01', otherAccountId).run()
    stubAkahu(() => onePage([]))
    pendingAnswer = () => asJson({ items: [pending()] })

    await runSync()

    expect(pendingCalls).toHaveLength(1)
    expect(await pendingRows()).toEqual([
      {
        account_id: accountId,
        // NZ 21 October: 11:00 UTC on the 20th is midnight the next day in NZDT, as a settled Transaction's date is read.
        date: '2026-10-21',
        amount_cents: -450,
        description: 'PENDING CAFE',
        bank_type: 'EFTPOS',
        synced_at: '2026-10-20T18:00:00.000Z',
      },
    ])
  })

  it('replaces the pending money on every Sync, so one that has settled or gone does not linger', async () => {
    stubAkahu(() => onePage([]))
    pendingAnswer = () => asJson({ items: [pending(), pending({ description: 'PENDING FUEL', amount: -80 })] })
    await runSync()
    expect(await pendingRows()).toHaveLength(2)

    pendingAnswer = () => asJson({ items: [pending({ description: 'PENDING FUEL', amount: -80 })] })
    await runSync()

    expect((await pendingRows()).map((row) => row.description)).toEqual(['PENDING FUEL'])
  })

  it('never keeps pending money for an account that was not linked', async () => {
    stubAkahu(() => onePage([]))
    pendingAnswer = () => asJson({ items: [pending({ _account: 'acc_notlinked00000000001' })] })

    await runSync()

    expect(await pendingRows()).toEqual([])
  })

  it('keeps what it holds when Akahu cannot be asked for the pending money, rather than emptying the list', async () => {
    stubAkahu(() => onePage([]))
    pendingAnswer = () => asJson({ items: [pending()] })
    await runSync()
    expect(await pendingRows()).toHaveLength(1)

    pendingAnswer = () => asJson({ message: 'Service unavailable' }, 503)
    await runSync()

    expect(await pendingRows()).toHaveLength(1)
    expect(logged.join('\n')).toContain('sync.pending.failed')
  })

  it('pending money does not reach the Transactions, so no total can count it', async () => {
    stubAkahu(() => onePage([]))
    pendingAnswer = () => asJson({ items: [pending()] })

    await runSync()

    expect(await rows()).toEqual([])
  })

  it('marks the Account Link broken when Akahu stops listing the Account, and removes no Transaction', async () => {
    stubAkahu(() => onePage([transaction()]))
    accountsAnswer = () => asJson({ items: [{ _id: LINKED, name: 'EXAMPLE' }] })
    await runSync()
    expect(await rows()).toHaveLength(1)
    expect((await accountState(accountId)).akahu_missing_since).toBeNull()

    // The second run: Akahu answers the list and no longer names the Account.
    accountsAnswer = () => asJson({ items: [] })
    await runSync()

    expect((await accountState(accountId)).akahu_missing_since).toBe('2026-10-20T18:00:00.000Z')
    expect(await rows()).toHaveLength(1)
    expect(logged.join('\n')).toContain('sync.account.link-broken')
  })

  it('keeps the first run that missed the Account, and clears the mark when Akahu lists it again', async () => {
    stubAkahu(() => onePage([transaction()]))
    accountsAnswer = () => asJson({ items: [] })
    await runSync()
    const first = (await accountState(accountId)).akahu_missing_since
    expect(first).not.toBeNull()
    await runSync()
    expect((await accountState(accountId)).akahu_missing_since).toBe(first)

    accountsAnswer = () => asJson({ items: [{ _id: LINKED, name: 'EXAMPLE' }] })
    await runSync()

    expect((await accountState(accountId)).akahu_missing_since).toBeNull()
  })

  it('says nothing about the Link when the account list itself failed', async () => {
    stubAkahu(() => onePage([transaction()]))
    accountsAnswer = () => asJson({ message: 'Service unavailable' }, 503)

    await runSync()

    expect((await accountState(accountId)).akahu_missing_since).toBeNull()
  })

  it.each([
    ['refused', 401],
    ['unreachable', 503],
  ] as const)('records "%s" as the cause when Akahu answers %i, for the status to name', async (reason, status) => {
    stubAkahu(() => asJson({ message: 'No' }, status))

    await runSync()

    expect((await accountState(accountId)).akahu_last_failure).toBe(reason)
  })

  it('records "unreadable" when Akahu answers with something that is not Transactions', async () => {
    stubAkahu(() => asJson({ items: [{ nothing: 'like a Transaction' }] }))

    await runSync()

    expect((await accountState(accountId)).akahu_last_failure).toBe('unreadable')
  })

  it('clears the cause when a Sync of the Account finishes, so the status stops naming it', async () => {
    stubAkahu(() => asJson({ message: 'No' }, 401))
    await runSync()
    expect((await accountState(accountId)).akahu_last_failure).toBe('refused')

    stubAkahu(() => onePage([transaction()]))
    await runSync()

    expect((await accountState(accountId)).akahu_last_failure).toBeNull()
    expect(await syncedAt(accountId)).not.toBeNull()
  })
})

// The review of this ticket found that marking a Link broken was not enough: the run went on to treat Akahu's answer for that
// Account as a finished window, which is what deletes Transactions Akahu no longer returns (spec 49). These pin the AC that a
// broken Link removes no Transaction, against the answer that actually does the damage — HTTP 200 with nothing in it.
describe('a broken Account Link is never a finished Sync', () => {
  const synced = async (id: number, akahuId: string, date = '2026-10-15') =>
    env.DB.prepare(
      `INSERT INTO transactions (account_id, date, amount_cents, description, source, akahu_id)
       VALUES (?1, ?2, -4250, 'COUNTDOWN ORMISTON', 'sync', ?3)`,
    )
      .bind(id, date, akahuId)
      .run()

  const failureOf = async (id: number) =>
    (await env.DB.prepare('SELECT akahu_last_failure FROM accounts WHERE id = ?').bind(id).first<{ akahu_last_failure: string | null }>())!.akahu_last_failure

  beforeEach(async () => {
    await env.DB.prepare('UPDATE accounts SET akahu_synced_at = ? WHERE id = ?').bind('2026-10-19T18:00:00.000Z', accountId).run()
    await synced(accountId, 'trans_0000000000000000001')
  })

  it('removes no Transaction when Akahu stops listing the Account and answers an empty page for it', async () => {
    accountsAnswer = () => asJson({ items: [] })
    stubAkahu(() => onePage([]))

    await runSync()

    expect(await rows()).toHaveLength(1)
    expect(logged.join('\n')).toContain('sync.account.link-broken')
  })

  it('leaves the last-success mark where it was, so the Account does not read as current', async () => {
    accountsAnswer = () => asJson({ items: [] })
    stubAkahu(() => onePage([]))

    await runSync()

    expect(await syncedAt(accountId)).toBe('2026-10-19T18:00:00.000Z')
  })

  it('does not call the run a success, and names the broken Link as the cause', async () => {
    accountsAnswer = () => asJson({ items: [] })
    stubAkahu(() => onePage([]))

    const outcome = await runSyncOutcome()

    expect(outcome.success).toBe(false)
    expect(outcome.accounts[0]).toMatchObject({ complete: false, failure: 'link-broken' })
    expect(await failureOf(accountId)).toBe('link-broken')
  })

  it('still takes up the Transactions Akahu does return for it', async () => {
    accountsAnswer = () => asJson({ items: [] })
    stubAkahu(() => onePage([transaction({ _id: 'trans_0000000000000000002' })]))

    await runSync()

    expect(await rows()).toHaveLength(2)
  })

  it('withdraws again, and marks the Account synced, once Akahu lists it anew', async () => {
    accountsAnswer = () => asJson({ items: [{ _id: LINKED, name: 'EXAMPLE' }] })
    stubAkahu(() => onePage([]))

    await runSync()

    // Akahu lists the Account and returns nothing for the window: that is a finished Sync, and the withdrawal is right to run.
    expect(await rows()).toHaveLength(0)
    expect(await syncedAt(accountId)).toBe('2026-10-20T18:00:00.000Z')
    expect(await failureOf(accountId)).toBeNull()
  })

  it('records why an Account the run could not start was left, so the status can say it', async () => {
    // No Cutover Date, so there is no window to ask for (ADR 0003).
    await env.DB.prepare('UPDATE accounts SET cutover_date = NULL, akahu_synced_at = NULL WHERE id = ?').bind(accountId).run()
    stubAkahu(() => onePage([]))

    await runSync()

    expect(await failureOf(accountId)).toBe('no-window')
  })
})

// Akahu may correct a Transaction it has already given (spec 49's re-check is there to see it). What was worked out from the old
// values, its Rule result and its Transfer pair, is worked out again from the new ones in the same batch; a row that comes back
// unchanged is left exactly as it was.
describe('a Transaction Akahu corrects', () => {
  const pairOf = async (id: number) => (await env.DB.prepare('SELECT transfer_of FROM transactions WHERE id = ?').bind(id).first<{ transfer_of: number | null }>())!.transfer_of
  const synced = async () => (await env.DB.prepare("SELECT id, transfer_of, rule_id, rule_category FROM transactions WHERE source = 'sync'").first<{ id: number; transfer_of: number | null; rule_id: number | null; rule_category: number | null }>())!
  const imported = async (amountCents: number) =>
    (await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source) VALUES (?, '2026-10-15', ?, 'TRANSFER FROM EVERYDAY', 'import') RETURNING id")
      .bind(otherAccountId, amountCents)
      .first<{ id: number }>())!.id
  const rule = async (text: string, position: number) => {
    const category = (await env.DB.prepare('INSERT INTO categories (name) VALUES (?) RETURNING id').bind(`Category for ${text}`).first<{ id: number }>())!.id
    const id = (await env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?) RETURNING id').bind(position, text, category).first<{ id: number }>())!.id
    return { id, category }
  }
  const syncs = async (over: Record<string, unknown>) => {
    stubAkahu(() => onePage([transaction(over)]))
    await runSync()
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rules').run()
    await env.DB.prepare('DELETE FROM categories').run()
  })

  it('lets go of the Transfer it no longer matches, and pairs with the one it now does', async () => {
    const was = await imported(4250)
    const now = await imported(5025)
    await syncs({})
    expect((await synced()).transfer_of).toBe(was)

    await syncs({ amount: -50.25 })

    const row = await synced()
    expect(row.transfer_of).toBe(now)
    expect(await pairOf(now)).toBe(row.id)
    expect(await pairOf(was)).toBeNull()
  })

  it('is no longer a Transfer when its new amount matches nothing, and neither is its old partner', async () => {
    const was = await imported(4250)
    await syncs({})

    await syncs({ amount: -50.25 })

    expect((await synced()).transfer_of).toBeNull()
    expect(await pairOf(was)).toBeNull()
  })

  it('lets go of the Transfer when only its date moves', async () => {
    const was = await imported(4250)
    await syncs({})

    await syncs({ date: '2026-10-16T00:00:00.000Z' })

    expect((await synced()).transfer_of).toBeNull()
    expect(await pairOf(was)).toBeNull()
  })

  it('takes the Rule its new words match, and none when no Rule matches them', async () => {
    const groceries = await rule('COUNTDOWN', 1)
    const hardware = await rule('MITRE 10', 2)
    await syncs({})
    expect(await synced()).toMatchObject({ rule_id: groceries.id, rule_category: groceries.category })

    await syncs({ description: 'MITRE 10 MEGA' })
    expect(await synced()).toMatchObject({ rule_id: hardware.id, rule_category: hardware.category })

    await syncs({ description: 'SOMEWHERE ELSE' })
    expect(await synced()).toMatchObject({ rule_id: null, rule_category: null })
  })

  it('takes the Rule its new amount matches', async () => {
    await env.DB.prepare("INSERT INTO categories (name) VALUES ('Big shop')").run()
    const big = (await env.DB.prepare("INSERT INTO rules (position, min_cents, category_id) SELECT 1, 5000, id FROM categories WHERE name = 'Big shop' RETURNING id").first<{ id: number }>())!.id
    await syncs({})
    expect((await synced()).rule_id).toBeNull()

    await syncs({ amount: -50.25 })

    expect((await synced()).rule_id).toBe(big)
  })

  it('leaves a row that comes back unchanged alone: its pair stays, and a Rule added since is not given to it', async () => {
    const partner = await imported(4250)
    await syncs({})
    await rule('COUNTDOWN', 1)

    await syncs({})

    expect(await synced()).toMatchObject({ transfer_of: partner, rule_id: null })
    expect(await pairOf(partner)).not.toBeNull()
  })
})

// A window too big for one run's pages (worker/akahu.ts: MAX_PAGES): the first Sync of an Account with an old Cutover Date, or one
// after Sync was off for months. A run asks for at most MAX_WINDOW_DAYS from where the window starts, and having read that much it
// marks the Account synced to where it stopped, so the next run starts from there (less the re-check) and a backlog of any length
// is caught up over a run or a few, rather than every run asking for the same first pages again.
describe('a long backlog', () => {
  const RUN_AT = '2026-10-20T18:00:00.000Z'
  const failureOf = async (id: number) =>
    (await env.DB.prepare('SELECT akahu_last_failure FROM accounts WHERE id = ?').bind(id).first<{ akahu_last_failure: string | null }>())!.akahu_last_failure
  const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions').first<{ n: number }>())!.n

  /** An Akahu with `perDay` Transactions on every NZ day from 2026-01-01 to the run, answering only for the range asked, 100 a page. */
  const busyAkahu = (perDay: number) =>
    stubAkahu((call) => {
      const query = new URL(call.url).searchParams
      const [start, end] = [Date.parse(query.get('start')!), Date.parse(query.get('end')!)]
      const items = []
      for (let at = Date.parse('2026-01-01T00:00:00.000Z'); at <= Date.parse(RUN_AT); at += 86_400_000) {
        if (at <= start || at > end) continue
        const day = new Date(at).toISOString().slice(0, 10).replaceAll('-', '')
        for (let k = 0; k < perDay; k++) items.push(transaction({ _id: `trans_${day}_${k}`, date: new Date(at).toISOString() }))
      }
      const offset = Number(query.get('cursor') ?? 0)
      return asJson({ items: items.slice(offset, offset + 100), cursor: { next: offset + 100 < items.length ? String(offset + 100) : null } })
    })

  beforeEach(async () => {
    await env.DB.prepare('UPDATE accounts SET cutover_date = ? WHERE id = ?').bind('2026-01-01', accountId).run()
  })

  it(`asks for at most ${MAX_WINDOW_DAYS} days, and marks the Account synced to where that stopped`, async () => {
    stubAkahu(() => onePage([]))

    const outcome = await runSyncOutcome()

    const until = nzDayStart('2026-03-02') // 2026-01-01 and 60 days
    expect(new URL(calls[0]!.url).searchParams.get('end')).toBe(until)
    expect(await syncedAt(accountId)).toBe(until)
    // Not up to date yet, so not a success, and the status can say why.
    expect(outcome.success).toBe(false)
    expect(outcome.accounts[0]).toMatchObject({ complete: false, failure: 'catching-up' })
    expect(await failureOf(accountId)).toBe('catching-up')
  })

  it('catches up a backlog bigger than one run can read, a part at a time', async () => {
    // 4,395 Transactions in all, over twice the pages one run may ask for.
    busyAkahu(15)

    let runs = 0
    while ((await syncedAt(accountId)) !== RUN_AT && runs < 10) {
      await runSync()
      runs++
    }

    expect(await syncedAt(accountId)).toBe(RUN_AT)
    expect(await count()).toBe(293 * 15)
    expect(await failureOf(accountId)).toBeNull()
  })

  it('withdraws nothing dated after the part of the window it read', async () => {
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, akahu_id) VALUES (?, '2026-10-10', -100, 'LATER', 'sync', 'trans_later')").bind(accountId).run()
    stubAkahu(() => onePage([]))

    await runSync()

    expect(await count()).toBe(1)
  })
})

describe('the text kept from Akahu', () => {
  it('cuts every text to AKAHU_TEXT_LIMIT, counting each, and leaves the paging cursor as it came', () => {
    const cut = { count: 0 }
    const long = 'A'.repeat(AKAHU_TEXT_LIMIT + 1)
    const answer = boundedText({ items: [{ description: long, merchant: { name: long }, amount: -1, nested: [long, 'short'] }], cursor: { next: long } }, cut)

    expect(answer).toEqual({ items: [{ description: long.slice(0, -1), merchant: { name: long.slice(0, -1) }, amount: -1, nested: [long.slice(0, -1), 'short'] }], cursor: { next: long } })
    expect(cut.count).toBe(3)
  })

  it('never leaves half a surrogate pair where it cuts', () => {
    const text = 'A'.repeat(AKAHU_TEXT_LIMIT - 1) + '\u{1F33F}' // the fern is two UTF-16 units, the cut falls between them
    const kept = boundedText(text) as string

    expect(kept).toHaveLength(AKAHU_TEXT_LIMIT)
    expect(kept.isWellFormed()).toBe(true)
    expect(kept.endsWith('\ufffd')).toBe(true)
  })
})
