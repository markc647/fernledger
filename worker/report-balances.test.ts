import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { HISTORY } from './balances'
import { balancesReport, REPORT_HISTORY, type BalancesReport, type HistoryRow } from './report-balances'

// Seam 1: the balances-over-time Report's data (GET /api/reports/balances), through the Worker's exported handler as the
// local-development Admin or a read-only Member (the dev identity cookie is honoured on localhost only). The Report's numbers are
// ticket 10's balance history picked out at month-ends, so the main test holds each of them to GET /api/balances/:id/history.
// All the data is made up (bank 99). An Account's opening balance before its first Transaction is $100.00.
const origin = 'http://localhost:5173'
const savings = '99-9999-9999999-99'
const cheque = '99-9999-9999999-98'
const OPENING = 10_000

type Who = 'admin' | 'member' | null

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const who = opts.who === undefined ? 'admin' : opts.who
  const headers: Record<string, string> = who ? { Cookie: `fernledger_dev_as=${who}` } : {}
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  // Without a sign-in the request comes from a host that is not localhost, where the dev identity is never honoured.
  const base = who ? origin : 'https://app.test'
  return exports.default.fetch(new Request(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

const tx = (id: string, date: string, amountCents: number) => ({ date, uniqueId: id, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE SHOP ${id}`, bankMemo: 'EFTPOS', amountCents })

type ImportOptions = {
  number?: string
  /** The balance the file's header gives: [date, cents]. */
  ledger: [string, number]
  /** The first and last dates the file covers; the last defaults to the balance's date. */
  from?: string
  to?: string
  cutoverDate?: string
}
async function importFile(rows: unknown[], options: ImportOptions) {
  const res = await call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account: { number: options.number ?? savings },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: options.from ?? '2026-07-01', to: options.to ?? options.ledger[0], ledgerBalance: { cents: options.ledger[1], date: options.ledger[0] } },
      rows,
      ...(options.cutoverDate ? { cutoverDate: options.cutoverDate } : {}),
    },
  })
  expect(res.status).toBe(200)
}

const accountId = async (number = savings) => (await env.DB.prepare('SELECT id FROM accounts WHERE account_number = ?').bind(number).first<{ id: number }>())!.id
const query = (id: number, from: string, to: string) => `accountId=${id}&from=${from}&to=${to}`
const report = async (from: string, to: string, number = savings, who: Who = 'member'): Promise<BalancesReport> => {
  const res = await call(`/api/reports/balances?${query(await accountId(number), from, to)}`, { who })
  expect(res.status, `${from} to ${to}`).toBe(200)
  return res.json()
}
type Point = { date: string; balanceCents: number }
const history = async (number = savings): Promise<{ anchor: { asOfDate: string; balanceCents: number } | null; points: Point[] }> => (await call(`/api/balances/${await accountId(number)}/history`)).json()

// Savings: $100.00 before its first Transaction. July leaves $140.00 on the 31st, August $120.00, September (no Transactions) the same,
// and October's two leave $123.00 on 7 October, the date of the bank's last balance.
const july = [tx('J1', '2026-07-10', 5000), tx('J2', '2026-07-31', -1000)]
const august = [tx('A1', '2026-08-15', -2000)]
const october = [tx('O1', '2026-10-05', -100), tx('O2', '2026-10-06', 400)]
const SAVINGS_TO_OCT_7 = OPENING + 5000 - 1000 - 2000 - 100 + 400
const importAllSavings = () => importFile([...july, ...august, ...october], { ledger: ['2026-10-07', SAVINGS_TO_OCT_7] })

beforeEach(async () => {
  await env.DB.batch(['balance_checks', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

const summary = (r: BalancesReport) => ({ opening: r.opening, rows: r.rows.map((row) => [row.date, row.balanceCents, row.changeCents]), closing: r.closing })

describe('the balances Report', () => {
  it('gives the opening balance, the balance at the end of each month and the closing balance', async () => {
    await importAllSavings()

    const r = await report('2026-07-01', '2026-10-31')

    expect(summary(r)).toEqual({
      opening: { balanceCents: OPENING, beforeFirst: true }, // before the first Transaction held
      rows: [
        ['2026-07-31', 14_000, 4000],
        ['2026-08-31', 12_000, -2000],
        ['2026-09-30', 12_000, 0], // no Transactions: the balance carries forward
        ['2026-10-07', 12_300, 300], // the last date held, not the end of the month
      ],
      closing: { date: '2026-10-07', balanceCents: 12_300 },
    })
    expect(r.held).toEqual({ from: '2026-07-10', to: '2026-10-07' })
    expect(r.anchor).toEqual({ asOfDate: '2026-10-07', balanceCents: 12_300 })
    expect(r.from).toBe('2026-07-01')
    expect(r.to).toBe('2026-10-31')
  })

  it('starts from the balance at the end of the day before a range that begins part way through the history', async () => {
    await importAllSavings()

    const r = await report('2026-08-20', '2026-10-31')

    expect(summary(r)).toEqual({
      opening: { balanceCents: 12_000, beforeFirst: false }, // what 15 August left, carried to 19 August
      rows: [
        ['2026-08-31', 12_000, 0],
        ['2026-09-30', 12_000, 0],
        ['2026-10-07', 12_300, 300],
      ],
      closing: { date: '2026-10-07', balanceCents: 12_300 },
    })
  })

  it('counts a Transaction on the first date asked for in the first month, and one on the day before in the opening balance', async () => {
    await importAllSavings()

    expect(summary(await report('2026-08-15', '2026-08-31'))).toMatchObject({ opening: { balanceCents: 14_000 }, rows: [['2026-08-31', 12_000, -2000]] })
    expect(summary(await report('2026-08-16', '2026-08-31'))).toMatchObject({ opening: { balanceCents: 12_000 }, rows: [['2026-08-31', 12_000, 0]] })
  })

  it('ends on the last date asked for when that is part way through a month', async () => {
    await importAllSavings()

    const r = await report('2026-10-01', '2026-10-05')

    expect(summary(r)).toEqual({ opening: { balanceCents: 12_000, beforeFirst: false }, rows: [['2026-10-05', 11_900, -100]], closing: { date: '2026-10-05', balanceCents: 11_900 } })
  })

  it('is a single row for one day', async () => {
    await importAllSavings()

    const r = await report('2026-10-06', '2026-10-06')

    expect(summary(r)).toEqual({ opening: { balanceCents: 11_900, beforeFirst: false }, rows: [['2026-10-06', 12_300, 400]], closing: { date: '2026-10-06', balanceCents: 12_300 } })
  })

  it('gives no balances before the first date held or after the last, and says what is held', async () => {
    await importAllSavings()

    for (const [from, to] of [
      ['2026-01-01', '2026-07-09'],
      ['2026-10-08', '2026-12-31'],
    ] as const) {
      const r = await report(from, to)
      expect(summary(r), `${from} to ${to}`).toEqual({ opening: null, rows: [], closing: null })
      expect(r.held).toEqual({ from: '2026-07-10', to: '2026-10-07' })
    }
  })

  it('stops at the last date held, however far the range runs, and starts at the first', async () => {
    await importAllSavings()

    const r = await report('2000-01-01', '2100-12-31')

    expect(r.rows.map((row) => row.date)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-07'])
    expect(r.opening).toEqual({ balanceCents: OPENING, beforeFirst: true })
    expect(r.closing).toEqual({ date: '2026-10-07', balanceCents: 12_300 })
  })

  it('has no balances for an Account with no bank balance to work from, and says why', async () => {
    // A file whose ledger balance is dated after the file ends can't be counted.
    await importFile(july, { ledger: ['2026-08-31', 14_000], to: '2026-07-31' })

    const r = await report('2026-07-01', '2026-08-31')

    expect(r).toMatchObject({ anchor: null, held: null, opening: null, rows: [], closing: null, latestStatus: 'file-ends-early', differences: [], checked: 0 })
  })

  it('has none for an Account whose only bank balance is on or after its Cutover Date', async () => {
    await importFile(july, { ledger: ['2026-10-01', 14_000], cutoverDate: '2026-10-01' })

    expect(await report('2026-07-01', '2026-10-31')).toMatchObject({ anchor: null, held: null, rows: [], latestStatus: 'after-cutover' })
  })

  it('keeps Accounts apart', async () => {
    await importAllSavings()
    await importFile([tx('X1', '2026-08-02', -777)], { number: cheque, ledger: ['2026-08-31', 5000] })

    expect(summary(await report('2026-08-01', '2026-08-31', cheque))).toEqual({
      opening: { balanceCents: 5777, beforeFirst: true },
      rows: [['2026-08-31', 5000, -777]],
      closing: { date: '2026-08-31', balanceCents: 5000 },
    })
    expect((await report('2026-08-01', '2026-08-31')).rows).toMatchObject([{ balanceCents: 12_000 }])
  })
})

describe('the balances Report matches balance history', () => {
  // The dates the sweep tries: before, on and after every Transaction, month-ends and the bank's balance date.
  const DATES = ['2000-01-01', '2026-06-30', '2026-07-01', '2026-07-10', '2026-07-31', '2026-08-01', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-31', '2026-09-15', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-31', '2100-12-31']

  const monthEnd = (day: string) => {
    const [year, month] = day.split('-').map(Number)
    return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10)
  }
  /** The month-end balances worked out from the daily history alone, as a reader of GET /api/balances/:id/history would. */
  function fromHistory(points: Point[], from: string, to: string, openingCents: number) {
    const first = points[0]!.date
    const last = points.at(-1)!.date
    const start = from > first ? from : first
    const end = to < last ? to : last
    const at = (day: string) => points.filter((p) => p.date <= day).at(-1)!.balanceCents
    const rows: [string, number][] = []
    if (start <= end) for (let day = monthEnd(start); ; day = monthEnd(new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10))) {
      const date = day < end ? day : end
      rows.push([date, at(date)])
      if (day >= end) break
    }
    const before = points.filter((p) => p.date < from).at(-1)
    return { rows, opening: start > end ? null : before ? before.balanceCents : openingCents, closing: start > end ? null : at(end) }
  }

  const sweep = async (number: string, openingCents: number) => {
    const { points } = await history(number)
    expect(points.length).toBeGreaterThan(2)
    let compared = 0
    for (const from of DATES)
      for (const to of DATES) {
        if (from > to) continue
        const r = await report(from, to, number)
        const expected = fromHistory(points, from, to, openingCents)
        expect({ rows: r.rows.map((row) => [row.date, row.balanceCents]), opening: r.opening?.balanceCents ?? null, closing: r.closing?.balanceCents ?? null }, `${from} to ${to}`).toEqual(expected)
        compared += 1
      }
    expect(compared).toBeGreaterThan(100)
  }

  it('gives the history’s balance on every date it reports, for ranges that begin before, in and after the history', async () => {
    await importAllSavings()
    await sweep(savings, OPENING)
  })

  it('matches for an Account with a Cutover Date, where a later bank balance does not count and Transactions stop at the Cutover Date', async () => {
    await importFile([...july, ...august], { ledger: ['2026-08-31', OPENING + 5000 - 1000 - 2000], cutoverDate: '2026-10-01' })
    // The October file's balance is dated after the Cutover Date, so history does not use it, and its Transactions are dropped.
    await importFile(october, { ledger: ['2026-10-07', 99_999], cutoverDate: '2026-10-01', from: '2026-09-01' })

    const { anchor, points } = await history()
    expect(anchor).toEqual({ asOfDate: '2026-08-31', balanceCents: 12_000 })
    expect(points.at(-1)).toEqual({ date: '2026-08-31', balanceCents: 12_000 })

    await sweep(savings, OPENING)
    const r = await report('2026-07-01', '2026-12-31')
    expect(r.closing).toEqual({ date: '2026-08-31', balanceCents: 12_000 }) // nothing is claimed after the last day held
    expect(r.held).toEqual({ from: '2026-07-10', to: '2026-08-31' })
  })

  it('matches for the second of two Accounts, with an older file imported after a newer one', async () => {
    await importAllSavings()
    await importFile([tx('C2', '2026-09-20', -300)], { number: cheque, ledger: ['2026-09-30', 4700], from: '2026-09-01' })
    await importFile([tx('C1', '2026-08-02', -1000)], { number: cheque, ledger: ['2026-08-31', 5000], from: '2026-08-01' })

    await sweep(cheque, 6000)
  })
})

describe('the balances Report says which balances the bank gave', () => {
  it('gives the bank’s figure on a row dated the day the bank gave one, and nothing on the others', async () => {
    await importFile([...july, ...august], { ledger: ['2026-08-31', 12_000] })
    await importFile(october, { ledger: ['2026-10-07', 12_300], from: '2026-09-01' })

    const r = await report('2026-07-01', '2026-10-31')

    expect(r.rows.map((row) => [row.date, row.balanceCents, row.bankCents])).toEqual([
      ['2026-07-31', 14_000, null],
      ['2026-08-31', 12_000, 12_000], // the bank said so on this very day
      ['2026-09-30', 12_000, null],
      ['2026-10-07', 12_300, 12_300],
    ])
  })

  it('gives a bank balance dated on the last date asked for even when it is not a month-end', async () => {
    await importFile([...july, ...august, october[0]!], { ledger: ['2026-10-05', 11_900] })
    await importFile([october[1]!], { ledger: ['2026-10-07', 12_300], from: '2026-10-06' })

    const r = await report('2026-10-01', '2026-10-05')

    expect(r.rows).toMatchObject([{ date: '2026-10-05', balanceCents: 11_900, bankCents: 11_900 }])
  })

  it('shows both figures when they differ, and never replaces the calculated one', async () => {
    await importFile([...july, ...august], { ledger: ['2026-08-31', 12_000] })
    // Missing O2 (+$4.00): the bank says $123.00 on 7 October and the Transactions add up to $119.00.
    await importFile([october[0]!], { ledger: ['2026-10-07', 12_300], from: '2026-09-01' })

    const r = await report('2026-07-01', '2026-10-31')

    // History is anchored on the latest bank balance, so the gap lifts every earlier figure by $4.00 (as GET /api/balances/:id/history says).
    expect(r.rows.map((row) => [row.date, row.balanceCents, row.bankCents])).toEqual([
      ['2026-07-31', 14_400, null],
      ['2026-08-31', 12_400, 12_000],
      ['2026-09-30', 12_400, null],
      ['2026-10-07', 12_300, 12_300],
    ])
  })
})

describe('the balances Report lists the Balance Check differences in its dates', () => {
  async function differing() {
    await importFile([...july, ...august], { ledger: ['2026-08-31', 12_000] })
    await importFile([october[0]!], { ledger: ['2026-10-07', 12_300], from: '2026-09-01' })
  }

  it('lists a difference whose span overlaps the dates, with the date the bank gave the balance and the date it is since', async () => {
    await differing()

    for (const [from, to] of [
      ['2026-09-01', '2026-12-31'],
      ['2026-10-07', '2026-10-07'],
      ['2026-07-01', '2026-09-01'], // the Transaction that is missing is dated after 31 August, so it can be in these dates
    ] as const) {
      const r = await report(from, to)
      expect(r.differences, `${from} to ${to}`).toEqual([{ asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: 400 }])
    }
  })

  it('lists none for dates the span does not touch, and counts the checks made in them', async () => {
    await differing()

    const before = await report('2026-07-01', '2026-08-31') // ends on the day the span starts after
    expect(before.differences).toEqual([])
    expect(before.checked).toBe(0) // nothing was compared in those dates

    const after = await report('2026-10-08', '2026-12-31')
    expect(after.differences).toEqual([])
    expect(after.checked).toBe(0)
  })

  it('says when a check was made and found no difference', async () => {
    await importFile([...july, ...august], { ledger: ['2026-08-31', 12_000] })
    await importFile(october, { ledger: ['2026-10-07', 12_300], from: '2026-09-01' })

    const r = await report('2026-09-01', '2026-10-31')

    expect(r.differences).toEqual([])
    expect(r.checked).toBe(1)
  })

  it('does not list another Account’s difference', async () => {
    await differing()
    await importFile([tx('X1', '2026-08-02', -777)], { number: cheque, ledger: ['2026-08-31', 5000] })

    expect((await report('2026-07-01', '2026-12-31', cheque)).differences).toEqual([])
  })
})

describe('the balances Report’s request', () => {
  const refusal = async (path: string) => {
    const res = await call(path)
    return { status: res.status, body: await res.json() }
  }

  it('is open to every Member and to the Admin, and to no one who is not signed in', async () => {
    await importAllSavings()
    const id = await accountId()
    for (const who of ['member', 'admin'] as const) expect((await call(`/api/reports/balances?${query(id, '2026-07-01', '2026-10-31')}`, { who })).status).toBe(200)
    expect((await call(`/api/reports/balances?${query(id, '2026-07-01', '2026-10-31')}`, { who: null })).status).toBe(401)
  })

  it('refuses a request that is not an Account and two real dates in order, naming the field and never the value', async () => {
    await importAllSavings()
    const id = await accountId()
    for (const [path, field] of [
      ['/api/reports/balances', 'accountId'],
      [`/api/reports/balances?from=2026-07-01&to=2026-07-31`, 'accountId'],
      [`/api/reports/balances?accountId=${id}&to=2026-07-31`, 'from'],
      [`/api/reports/balances?accountId=${id}&from=2026-07-01`, 'to'],
      [`/api/reports/balances?accountId=abc&from=2026-07-01&to=2026-07-31`, 'accountId'],
      [`/api/reports/balances?accountId=0&from=2026-07-01&to=2026-07-31`, 'accountId'],
      [`/api/reports/balances?accountId=1234567890&from=2026-07-01&to=2026-07-31`, 'accountId'],
      [`/api/reports/balances?accountId=${id}&from=2026-02-30&to=2026-07-31`, 'from'],
      [`/api/reports/balances?accountId=${id}&from=1999-12-31&to=2026-07-31`, 'from'],
      [`/api/reports/balances?accountId=${id}&from=2026-07-01&to=2101-01-01`, 'to'],
      [`/api/reports/balances?accountId=${id}&from=2026-07-31&to=2026-07-01`, 'to'],
    ] as const) {
      expect(await refusal(path), path).toEqual({ status: 400, body: { error: 'Invalid request', field } })
    }
  })

  it('says there is no such Account', async () => {
    expect(await refusal(`/api/reports/balances?${query(999_999, '2026-07-01', '2026-07-31')}`)).toEqual({ status: 404, body: { error: 'Not found' } })
  })
})

describe('the balances Report’s months', () => {
  const none = { anchor: null, latestStatus: null, bank: [], checked: 0, differences: [] }
  const request = { accountId: 1, from: '2023-01-01', to: '2024-12-31' }
  // The history query's rows for an Account held from 15 November 2023 to 10 March 2024: the month-end rows are the last date in each month with Transactions.
  const history: HistoryRow[] = [
    { kind: 'first', date: '2023-11-15', balanceCents: 1000 },
    { kind: 'last', date: '2024-03-10', balanceCents: 1500 },
    { kind: 'month', date: '2023-11-20', balanceCents: 1200 },
    { kind: 'month', date: '2024-02-12', balanceCents: 1400 },
    { kind: 'month', date: '2024-03-10', balanceCents: 1500 },
  ]

  it('writes a row for each month across a year end and a leap February, carrying the balance through months without Transactions', () => {
    const r = balancesReport(request, { ...none, history })

    expect(r.rows.map((row) => [row.date, row.balanceCents, row.changeCents])).toEqual([
      ['2023-11-30', 1200, 200],
      ['2023-12-31', 1200, 0],
      ['2024-01-31', 1200, 0],
      ['2024-02-29', 1400, 200],
      ['2024-03-10', 1500, 100],
    ])
    expect(r.opening).toEqual({ balanceCents: 1000, beforeFirst: true })
  })

  it('has nothing to say without a first and last date: no balance can be worked out', () => {
    expect(balancesReport(request, { ...none, history: [] })).toMatchObject({ held: null, opening: null, rows: [], closing: null })
  })

  it('refuses to guess the opening balance of dates that begin inside the history when it has none for the day before', () => {
    expect(() => balancesReport({ ...request, from: '2024-01-01' }, { ...none, history })).toThrow('no balance before')
  })
})

describe('the balances Report’s cost (ADR 0004)', () => {
  const TRANSACTIONS = 6000

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO accounts (id, name, account_number) VALUES (1, 'Example savings', ?)").bind(savings).run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO transactions (account_id, date, amount_cents, description, source)
       SELECT 1, date('2010-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import' FROM seq`,
    ).run()
    await env.DB.prepare(
      "INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (1, '2015-01-01', 123456, 'import', (SELECT MAX(id) FROM transactions), 'alone')",
    ).run()
  })

  const run = async (sql: string, ...binds: unknown[]) => {
    const result = await env.DB.prepare(sql).bind(...binds).run()
    return { rows: result.results.length, read: (result.meta as { rows_read: number }).rows_read }
  }

  it('returns a row a month, and reads about a quarter more than balance history does: the history once, and its rows again for each kind of row', async () => {
    const daily = await run(HISTORY, 1, null, null)
    const monthly = await run(REPORT_HISTORY, 1, '2010-01-01', '2100-12-31')

    expect(daily.rows).toBeGreaterThan(1400) // a point a day for four years
    expect(monthly.rows).toBeLessThanOrEqual(12 * 5 + 3) // the months of about four years, and the three single rows that frame them
    expect(daily.read).toBeGreaterThan(TRANSACTIONS * 4) // the bounds below mean something: history reads each Transaction several times
    expect(monthly.read).toBeLessThanOrEqual(daily.read * 1.3 + 100)
    expect(monthly.read).toBeLessThanOrEqual(TRANSACTIONS * 7 + 100) // the figure ADR 0004 gives: about 6 reads for each Transaction of the Account
  })

  it('reads the same however narrow the dates, because the balance is worked out from every Transaction', async () => {
    const wide = await run(REPORT_HISTORY, 1, '2010-01-01', '2100-12-31')
    const narrow = await run(REPORT_HISTORY, 1, '2012-03-01', '2012-03-31')

    expect(narrow.rows).toBeLessThan(wide.rows)
    expect(narrow.read).toBeLessThanOrEqual(wide.read + 100)
  })
})
