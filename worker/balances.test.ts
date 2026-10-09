import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { OPENINGS, recordBalance } from './balance-check'
import { CURRENT, HISTORY } from './balances'
import worker from './index'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only; Access token handling is tested in api.test.ts).
// All the data is made up (bank 99). The Account's opening balance before its first Transaction is $100.00.
const origin = 'http://localhost:5173'
const savings = '99-9999-9999999-99'
const current = '99-9999-9999999-98'
const OPENING = 10_000

type Who = 'admin' | 'member' | null

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const who = opts.who === undefined ? 'admin' : opts.who
  const headers: Record<string, string> = who ? { Cookie: `fernledger_dev_as=${who}` } : {}
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  // Without a sign-in the request comes from a host that is not localhost, where the dev identity is never honoured.
  const base = who ? origin : 'https://app.test'
  return exports.default.fetch(
    new Request(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

const tx = (id: string, date: string, amountCents: number) => ({
  date,
  uniqueId: id,
  tranType: 'EFTPOS',
  chequeNumber: null,
  payee: `EXAMPLE SHOP ${id}`,
  bankMemo: 'EFTPOS',
  amountCents,
})

type ImportOptions = {
  number?: string
  /** The balance the file's header gives: [date, cents]. */
  ledger: [string, number]
  /** The last date the file covers; defaults to the balance's date. */
  to?: string
  index?: number
  count?: number
  cutoverDate?: string
  replace?: boolean
}

const importFile = (rows: unknown[], options: ImportOptions, who: Who = 'admin') =>
  call('/api/imports/chunks', {
    who,
    method: 'POST',
    body: {
      account: { number: options.number ?? savings },
      chunk: { index: options.index ?? 0, count: options.count ?? 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-09-01', to: options.to ?? options.ledger[0], ledgerBalance: { cents: options.ledger[1], date: options.ledger[0] } },
      rows,
      ...(options.cutoverDate ? { cutoverDate: options.cutoverDate } : {}),
      ...(options.replace ? { replace: true } : {}),
    },
  })

// Savings from an opening balance of $100.00: three September Transactions leave $105.00 on 30 September.
const september = [tx('S1', '2026-09-10', 1000), tx('S2', '2026-09-12', -200), tx('S3', '2026-09-20', -300)]
const SEPT_30: [string, number] = ['2026-09-30', OPENING + 500]
// Two October Transactions leave $108.00 on 7 October.
const october = [tx('O1', '2026-10-05', -100), tx('O2', '2026-10-06', 400)]
const OCT_7: [string, number] = ['2026-10-07', OPENING + 800]

type Outcome = { status: string; asOfDate: string; since: string | null; differenceCents: number | null }
const outcomeOf = async (res: Response): Promise<Outcome | null> => ((await res.json()) as { balanceCheck?: Outcome | null }).balanceCheck ?? null

type BalanceRow = { accountId: number; accountName: string; balanceCents: number | null; asOfDate: string | null }
const balances = async (who: Who = 'admin'): Promise<BalanceRow[]> => ((await (await call('/api/balances', { who })).json()) as { accounts: BalanceRow[] }).accounts
type Difference = { accountId: number; accountName: string; asOfDate: string; since: string; differenceCents: number }
type Checks = { differences: Difference[]; accounts: { accountId: number; asOfDate: string | null; status: string | null }[] }
const checks = async (who: Who = 'admin'): Promise<Checks> => (await call('/api/balance-checks', { who })).json()
const accountId = async (number = savings) => (await env.DB.prepare('SELECT id FROM accounts WHERE account_number = ?').bind(number).first<{ id: number }>())!.id
type History = { accountId: number; anchor: { asOfDate: string; balanceCents: number } | null; points: { date: string; balanceCents: number }[] }
const history = async (query = '', who: Who = 'admin', number = savings): Promise<History> => (await call(`/api/balances/${await accountId(number)}/history${query}`, { who })).json()

beforeEach(async () => {
  await env.DB.batch(['balance_checks', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

describe('balance history', () => {
  it('is computed backwards from the ledger balance of the only Import', async () => {
    await importFile(september, { ledger: SEPT_30 })

    expect(await history()).toEqual({
      accountId: await accountId(),
      anchor: { asOfDate: '2026-09-30', balanceCents: 10_500 },
      points: [
        { date: '2026-09-10', balanceCents: 11_000 },
        { date: '2026-09-12', balanceCents: 10_800 },
        { date: '2026-09-20', balanceCents: 10_500 },
        { date: '2026-09-30', balanceCents: 10_500 },
      ],
    })
  })

  it('covers every Import, anchored on the latest ledger balance', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: OCT_7 })

    const { anchor, points } = await history()

    expect(anchor).toEqual({ asOfDate: '2026-10-07', balanceCents: 10_800 })
    expect(points.map((p) => [p.date, p.balanceCents])).toEqual([
      ['2026-09-10', 11_000],
      ['2026-09-12', 10_800],
      ['2026-09-20', 10_500],
      ['2026-10-05', 10_400],
      ['2026-10-06', 10_800],
      ['2026-10-07', 10_800],
    ])
  })

  it('is the same however the Imports arrive: an older file imported later fills in the past', async () => {
    await importFile(october, { ledger: OCT_7 })
    expect((await history()).points.map((p) => p.balanceCents)).toEqual([10_400, 10_800, 10_800])
    await importFile(september, { ledger: SEPT_30 })

    const { points } = await history()

    expect(points.map((p) => [p.date, p.balanceCents])).toEqual([
      ['2026-09-10', 11_000],
      ['2026-09-12', 10_800],
      ['2026-09-20', 10_500],
      ['2026-10-05', 10_400],
      ['2026-10-06', 10_800],
      ['2026-10-07', 10_800],
    ])
  })

  it('adds Transactions dated after the latest ledger balance going forwards', async () => {
    await importFile([...september, tx('S4', '2026-10-02', -250)], { ledger: SEPT_30, to: '2026-10-02' })

    const { points } = await history()

    expect(points.at(-2)).toEqual({ date: '2026-09-30', balanceCents: 10_500 })
    expect(points.at(-1)).toEqual({ date: '2026-10-02', balanceCents: 10_250 })
  })

  it('keeps Accounts apart', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile([tx('S1', '2026-09-11', -777)], { number: current, ledger: ['2026-09-30', 5000] })

    expect((await history('', 'admin', current)).points).toEqual([
      { date: '2026-09-11', balanceCents: 5000 },
      { date: '2026-09-30', balanceCents: 5000 },
    ])
    expect((await history()).points).toHaveLength(4)
  })

  it('can be limited to a range of dates', async () => {
    await importFile(september, { ledger: SEPT_30 })

    const { points } = await history('?from=2026-09-12&to=2026-09-20')

    expect(points.map((p) => p.date)).toEqual(['2026-09-12', '2026-09-20'])
    expect(points.map((p) => p.balanceCents)).toEqual([10_800, 10_500])
  })

  it('has no points for an Account without a ledger balance, and says so', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await env.DB.prepare('DELETE FROM balance_checks').run()

    expect(await history()).toMatchObject({ anchor: null, points: [] })
  })

  it('refuses a missing Account (404) and a malformed range (400)', async () => {
    expect((await call('/api/balances/999/history')).status).toBe(404)
    expect((await call('/api/balances/abc/history')).status).toBe(404)
    await importFile(september, { ledger: SEPT_30 })
    const id = await accountId()
    expect((await call(`/api/balances/${id}/history?from=2026-13-01`)).status).toBe(400)
    expect((await call(`/api/balances/${id}/history?to=yesterday`)).status).toBe(400)
  })
})

describe('current balances', () => {
  it('is the latest ledger balance plus Transactions dated after it, for every Account', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile([tx('X1', '2026-09-15', -1234)], { number: current, ledger: ['2026-09-30', 4000] })
    await importFile([tx('S4', '2026-10-02', -250)], { ledger: SEPT_30, to: '2026-10-02' })

    expect(await balances()).toEqual([
      { accountId: await accountId(current), accountName: current, balanceCents: 4000, asOfDate: '2026-09-30', cutoverDate: null, latestStatus: 'alone' },
      { accountId: await accountId(), accountName: savings, balanceCents: 10_250, asOfDate: '2026-10-02', cutoverDate: null, latestStatus: 'alone' },
    ])
  })

  it('is the last point of the Account history', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: OCT_7 })

    const [account] = await balances()
    const { points } = await history()

    expect(account!.balanceCents).toBe(points.at(-1)!.balanceCents)
    expect(account!.asOfDate).toBe(points.at(-1)!.date)
  })

  it('is null for an Account with no ledger balance yet', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await env.DB.prepare('DELETE FROM balance_checks').run()

    expect(await balances()).toMatchObject([{ accountName: savings, balanceCents: null, asOfDate: null }])
  })
})

describe('the Balance Check after an Import', () => {
  it('has nothing to compare the first balance with', async () => {
    const res = await importFile(september, { ledger: SEPT_30 })

    expect(await outcomeOf(res)).toEqual({ status: 'alone', asOfDate: '2026-09-30', since: null, differenceCents: null })
    expect((await checks()).differences).toEqual([])
  })

  it('matches when the Transactions since the last balance add up to the bank', async () => {
    await importFile(september, { ledger: SEPT_30 })

    const res = await importFile(october, { ledger: OCT_7 })

    expect(await outcomeOf(res)).toEqual({ status: 'matched', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 0 })
    expect((await checks()).differences).toEqual([])
  })

  it('finds a mismatch, and says by how much and since when', async () => {
    await importFile(september, { ledger: SEPT_30 })

    // The bank's balance is $5.00 more than the October rows explain: money in is missing.
    const res = await importFile(october, { ledger: ['2026-10-07', OPENING + 800 + 500] })

    expect(await outcomeOf(res)).toEqual({ status: 'differs', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 500 })
    expect((await checks()).differences).toEqual([
      { accountId: await accountId(), accountName: savings, asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 500 },
    ])
  })

  it('reports the bank as lower than the Transactions with a negative difference', async () => {
    await importFile(september, { ledger: SEPT_30 })

    const res = await importFile(october, { ledger: ['2026-10-07', OPENING + 800 - 1234] })

    expect(await outcomeOf(res)).toMatchObject({ status: 'differs', differenceCents: -1234 })
  })

  it('clears when a later Import supplies the missing Transaction', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile([october[0]!], { ledger: OCT_7 })
    expect((await checks()).differences).toMatchObject([{ differenceCents: 400 }])

    const res = await importFile(october, { ledger: OCT_7 })

    expect(await outcomeOf(res)).toMatchObject({ status: 'matched', differenceCents: 0 })
    expect((await checks()).differences).toEqual([])
  })

  it('clears an older mismatch when an Import fills the gap, even though a newer balance matched', async () => {
    await importFile(september, { ledger: SEPT_30 })
    // 7 October is $5.00 off because O2 is missing; the next week then matches its own predecessor.
    await importFile([october[0]!], { ledger: OCT_7 })
    await importFile([tx('N1', '2026-10-10', -50)], { ledger: ['2026-10-14', OPENING + 750], to: '2026-10-14' })
    expect((await checks()).differences).toMatchObject([{ asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 400 }])

    await importFile([october[1]!], { ledger: OCT_7 })

    expect((await checks()).differences).toEqual([])
  })

  it('recognises the matching Transactions of an overlapping file only once', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: OCT_7 })

    const res = await importFile([...september.slice(1), ...october], { ledger: OCT_7 })

    expect(await outcomeOf(res)).toMatchObject({ status: 'matched' })
  })

  it('checks the span after an older file that is imported later', async () => {
    await importFile(october, { ledger: OCT_7 })

    const res = await importFile(september, { ledger: SEPT_30 })

    expect(await outcomeOf(res)).toEqual({ status: 'matched', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 0 })
  })

  it('checks every Account on its own', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: ['2026-10-07', OPENING + 900] })
    await importFile([tx('X1', '2026-09-15', -100)], { number: current, ledger: ['2026-09-30', 900] })

    const { differences, accounts } = await checks()

    expect(differences).toMatchObject([{ accountName: savings }])
    expect(accounts.map((a) => [a.status])).toEqual([['alone'], ['differs']])
  })

  it('only runs after the last chunk of an Import, which is when the balance is recorded', async () => {
    const first = await importFile(september.slice(0, 2), { ledger: SEPT_30, index: 0, count: 2 })
    expect(await outcomeOf(first)).toBeNull()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM balance_checks').first<{ n: number }>())!.n).toBe(0)

    const last = await importFile(september.slice(2), { ledger: SEPT_30, index: 1, count: 2 })

    expect(await outcomeOf(last)).toMatchObject({ status: 'alone' })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM balance_checks').first<{ n: number }>())!.n).toBe(1)
    expect((await balances())[0]!.balanceCents).toBe(10_500)
  })

  it('records the same balance again, rather than twice, when a file is imported again', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(september, { ledger: SEPT_30 })

    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM balance_checks').first<{ n: number }>())!.n).toBe(1)
  })
})

describe('the Balance Check on boundary dates', () => {
  it('counts a Transaction dated on the balance date, and not one dated the day after', async () => {
    await importFile([tx('A', '2026-09-30', -500)], { ledger: ['2026-09-30', 4500] })

    // 1 and 7 October fall in the span being checked (the 7th is its last day); 8 October is after the balance.
    const res = await importFile([tx('B', '2026-10-01', -100), tx('C', '2026-10-07', -400), tx('D', '2026-10-08', -3000)], {
      ledger: ['2026-10-07', 4000],
      to: '2026-10-08',
    })

    expect(await outcomeOf(res)).toEqual({ status: 'matched', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: 0 })
    // The 8 October Transaction is after the balance, so the current balance includes it.
    expect((await balances())[0]).toMatchObject({ balanceCents: 1000, asOfDate: '2026-10-08' })
  })

  it('does not count a Transaction dated on the earlier balance date a second time', async () => {
    await importFile([tx('A', '2026-09-30', -500)], { ledger: ['2026-09-30', 4500] })

    const res = await importFile([tx('B', '2026-10-01', -100)], { ledger: ['2026-10-01', 4400] })

    expect(await outcomeOf(res)).toMatchObject({ status: 'matched' })
  })

  it('is not fooled by a last day the bank had not finished when the earlier file was exported', async () => {
    // The 30 September file held one Transaction of that day; the bank posted another later that day.
    await importFile([tx('A', '2026-09-30', -500)], { ledger: ['2026-09-30', 4500] })

    const res = await importFile([tx('A2', '2026-09-30', -200), tx('B', '2026-10-01', -100)], { ledger: ['2026-10-01', 4200] })

    expect(await outcomeOf(res)).toMatchObject({ status: 'matched', since: '2026-09-30' })
    expect((await checks()).differences).toEqual([])
  })

  it('counts that late Transaction in the day it is dated, in balance history', async () => {
    await importFile([tx('A', '2026-09-30', -500)], { ledger: ['2026-09-30', 4500] })
    await importFile([tx('A2', '2026-09-30', -200), tx('B', '2026-10-01', -100)], { ledger: ['2026-10-01', 4200] })

    expect((await history()).points.map((p) => [p.date, p.balanceCents])).toEqual([
      ['2026-09-30', 4300], // $50.00 before the first Transaction, less both of the day's Transactions
      ['2026-10-01', 4200],
    ])
  })
})

describe('the Balance Check and the Cutover Date', () => {
  it('counts a balance dated the day before the Cutover Date', async () => {
    const res = await importFile(september, { ledger: SEPT_30, cutoverDate: '2026-10-01' })

    expect(await outcomeOf(res)).toMatchObject({ status: 'alone' })
    expect((await balances())[0]!.balanceCents).toBe(10_500)
  })

  it('does not count a balance dated on the Cutover Date, because Sync supplies those days', async () => {
    const res = await importFile(september, { ledger: ['2026-10-01', 10_500], cutoverDate: '2026-10-01' })

    expect(await outcomeOf(res)).toMatchObject({ status: 'after-cutover', since: null, differenceCents: null })
    expect((await balances())[0]).toMatchObject({ balanceCents: null, asOfDate: null })
    expect((await history()).anchor).toBeNull()
  })

  it('does not count a balance dated after the Cutover Date, and never raises a difference for it', async () => {
    await importFile(september, { ledger: SEPT_30 })

    const res = await importFile(october, { ledger: ['2026-10-07', 99_999], cutoverDate: '2026-10-01' })

    expect(await outcomeOf(res)).toMatchObject({ status: 'after-cutover' })
    expect((await checks()).differences).toEqual([])
    // The usable balance is still the September one.
    expect((await balances())[0]!.balanceCents).toBe(10_500)
  })

  it('uses the Cutover Date an earlier Import set on the Account', async () => {
    await importFile(september, { ledger: SEPT_30, cutoverDate: '2026-10-01' })

    const res = await importFile(october, { ledger: OCT_7 })

    expect(await outcomeOf(res)).toMatchObject({ status: 'after-cutover' })
  })
})

describe('the Balance Check on a file that ends before its balance date', () => {
  it('does not count the balance, because Transactions in between may be missing', async () => {
    await importFile(september, { ledger: SEPT_30 })

    const res = await importFile(october, { ledger: OCT_7, to: '2026-10-06' })

    expect(await outcomeOf(res)).toMatchObject({ status: 'file-ends-early' })
    expect((await checks()).differences).toEqual([])
    expect((await balances())[0]).toMatchObject({ balanceCents: 10_500 + 300, asOfDate: '2026-10-06' })
  })
})

describe('replacing imported history', () => {
  it('removes the ledger balances of the old Imports, then records the new file', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: OCT_7 })

    const res = await importFile(september, { ledger: ['2026-09-30', 20_500], replace: true })

    expect(res.status).toBe(200)
    expect(await outcomeOf(res)).toMatchObject({ status: 'alone', asOfDate: '2026-09-30' })
    expect((await env.DB.prepare('SELECT as_of_date AS d FROM balance_checks').all<{ d: string }>()).results.map((r) => r.d)).toEqual(['2026-09-30'])
    expect((await history()).points.map((p) => p.balanceCents)).toEqual([21_000, 20_800, 20_500, 20_500])
  })

  it('leaves a Sync balance alone', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await env.DB.prepare(
      "INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (?, '2026-10-20', 1, 'sync', 0, 'alone')",
    ).bind(await accountId()).run()

    await importFile(september, { ledger: SEPT_30, replace: true })

    expect((await env.DB.prepare('SELECT source FROM balance_checks ORDER BY as_of_date').all<{ source: string }>()).results.map((r) => r.source)).toEqual(['import', 'sync'])
  })

  it('removes the balances when the imported history is cleared in steps, and not when the step is refused', async () => {
    await importFile(september, { ledger: SEPT_30 })
    const id = await accountId()
    const balanceRows = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM balance_checks').first<{ n: number }>())!.n
    // A history of 3 rows is small enough to replace in one go, so clearing a step is refused and changes nothing.
    expect((await call('/api/imports/clear-history', { method: 'POST', body: { accountId: id } })).status).toBe(409)
    expect(await balanceRows()).toBe(1)

    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5200)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) SELECT ?, '2026-08-01', 1, 'X', 'import', 'BULK' || i FROM n`,
    ).bind(id).run()
    const res = await call('/api/imports/clear-history', { method: 'POST', body: { accountId: id } })

    expect(res.status).toBe(200)
    expect(await balanceRows()).toBe(0)
  })
})

describe('who can read balances', () => {
  const paths = async () => ['/api/balances', '/api/balance-checks', `/api/balances/${await accountId()}/history`]

  it('lets a Member read all of them', async () => {
    await importFile(september, { ledger: SEPT_30 })
    for (const path of await paths()) expect((await call(path, { who: 'member' })).status, path).toBe(200)
    expect((await balances('member'))[0]!.balanceCents).toBe(10_500)
  })

  it('refuses a request without a sign-in', async () => {
    await importFile(september, { ledger: SEPT_30 })
    for (const path of await paths()) expect((await call(path, { who: null })).status, path).toBe(401)
  })

  it('refuses a Member who tries to record a balance by importing', async () => {
    const res = await importFile(september, { ledger: SEPT_30 }, 'member')

    expect(res.status).toBe(403)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM balance_checks').first<{ n: number }>())!.n).toBe(0)
  })
})

describe('the ledger balance in an Import request', () => {
  const body = (ledgerBalance: unknown) => ({
    account: { number: savings },
    chunk: { index: 0, count: 1 },
    file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-09-01', to: '2026-09-30', ...(ledgerBalance === undefined ? {} : { ledgerBalance }) },
    rows: [tx('S1', '2026-09-10', 1000)],
  })

  it.each([
    ['missing', undefined],
    ['not a date', { cents: 1, date: 'yesterday' }],
    ['not a real date', { cents: 1, date: '2026-02-30' }],
    ['not whole cents', { cents: 1.5, date: '2026-09-30' }],
    ['not a number', { cents: '1', date: '2026-09-30' }],
  ])('refuses a balance that is %s, and saves nothing', async (_name, ledgerBalance) => {
    const res = await call('/api/imports/chunks', { method: 'POST', body: body(ledgerBalance) })

    expect(res.status).toBe(400)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions').first<{ n: number }>())!.n).toBe(0)
  })

  it('accepts a negative balance, as for an overdrawn Account', async () => {
    const res = await importFile(september, { ledger: ['2026-09-30', -2500] })

    expect(res.status).toBe(200)
    expect((await balances())[0]!.balanceCents).toBe(-2500)
  })
})

describe('how a balance is recorded', () => {
  const recorded = async () =>
    (await env.DB.prepare('SELECT as_of_date AS date, bank_cents AS cents, source, status, difference_cents AS difference FROM balance_checks ORDER BY as_of_date').all<{ date: string; cents: number; source: string; status: string; difference: number | null }>()).results
  const record = (asOfDate: string, bankCents: number, source: 'import' | 'sync') =>
    recordBalance(env.DB, { accountNumber: savings, asOfDate, bankCents, source, status: 'alone' }).run()

  it('does not let an Import replace the Sync balance for the same date', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await record('2026-09-30', 99_999, 'sync')

    const res = await importFile(september, { ledger: ['2026-09-30', 12_345] })

    expect(res.status).toBe(200)
    expect(await recorded()).toMatchObject([{ date: '2026-09-30', cents: 99_999, source: 'sync' }])
  })

  it('lets Sync replace the Import balance for the same date', async () => {
    await importFile(september, { ledger: SEPT_30 })

    await record('2026-09-30', 99_999, 'sync')

    expect(await recorded()).toMatchObject([{ date: '2026-09-30', cents: 99_999, source: 'sync' }])
  })

  it('keeps the previous result until the Balance Check has run again, so a failed refresh cannot hide a difference', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await importFile(october, { ledger: ['2026-10-07', OPENING + 800 + 500] })
    expect(await recorded()).toMatchObject([{}, { status: 'differs', difference: 500 }])

    // The same date is recorded again with a balance that agrees; the statement alone cannot know that.
    await record('2026-10-07', OPENING + 800, 'import')

    expect(await recorded()).toMatchObject([{}, { cents: OPENING + 800, status: 'differs', difference: 500 }])
    expect((await checks()).differences).toHaveLength(1)
    // The refresh that follows in an Import settles it.
    await importFile(october, { ledger: OCT_7 })
    expect((await checks()).differences).toEqual([])
  })
})

describe('the cost of a request (ADR 0004)', () => {
  const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail)

  it("reads one Account's Transactions through the account-and-date index for history, openings and the current balance", async () => {
    for (const details of [await plan(HISTORY, 1, null, null), await plan(OPENINGS, 1), await plan(CURRENT)]) {
      const reads = details.filter((d) => /^(SEARCH|SCAN) (t|transactions)\b/.test(d))
      expect(reads.length).toBeGreaterThan(0)
      for (const read of reads) expect(read).toMatch(/^SEARCH .* USING (COVERING )?INDEX transactions_account_date/)
    }
  })

  // The worst last chunk: it replaces history and sets the Cutover Date on an existing Account. The comment on the
  // limits in imports.ts says how many D1 queries that is; a statement in a batch counts as one query each.
  it('prepares at most 13 D1 statements for the last chunk of a replacing Import', async () => {
    await importFile(september, { ledger: SEPT_30 })
    const prepared: string[] = []
    const countingDb = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => (prepared.push(sql), target.prepare(sql))
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const ctx = createExecutionContext()
    const request = new Request(`${origin}/api/imports/chunks`, {
      method: 'POST',
      headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: { number: savings },
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: 3, skipped: 0, from: '2026-09-01', to: '2026-09-30', ledgerBalance: { cents: OPENING + 500, date: '2026-09-30' } },
        rows: september,
        cutoverDate: '2026-12-01',
        replace: true,
      }),
    })

    const res = await worker.fetch!(request as never, { ...env, DB: countingDb }, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    // find the Account, count the rows to replace, count the new rows, find the highest Transaction ID, then in one batch:
    // set the Cutover Date, remove the balances, remove the rows, insert, record the balance, the Change Log entry; then
    // apply the Rules to the rows just added, and read and save the check.
    expect(prepared).toHaveLength(13)
  })
})

describe('why an Account has no balance', () => {
  it('says the newest bank balance is after the Cutover Date, and gives the Cutover Date', async () => {
    await importFile(september, { ledger: ['2026-10-05', OPENING], to: '2026-10-05', cutoverDate: '2026-10-01' })

    expect((await balances())[0]).toMatchObject({ balanceCents: null, asOfDate: null, cutoverDate: '2026-10-01', latestStatus: 'after-cutover' })
  })

  it('has no status and no Cutover Date for an Account that has neither', async () => {
    await importFile(september, { ledger: SEPT_30 })
    await env.DB.prepare('DELETE FROM balance_checks').run()

    expect((await balances())[0]).toMatchObject({ balanceCents: null, cutoverDate: null, latestStatus: null })
  })
})
