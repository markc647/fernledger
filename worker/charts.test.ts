import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SpendingByCategory } from './chart-spending'
import worker from './index'
import { EVERY_DATE, MAX_NET_WORTH_ACCOUNTS, type NetWorth } from './net-worth'
import { monthEnd, monthsBefore, monthStart, nzMonth } from './months'

// Seam 1: the numbers behind the charts (GET /api/charts/net-worth and /spending), through the Worker's exported handler as the local-development
// Admin or a read-only Member (the dev identity cookie is honoured on localhost only). Net worth is the Accounts' balance history added up, so the main
// test holds each of its points to GET /api/balances/:id/history. Spending is spending.ts's, so the tests check what the chart leaves out (Transfers,
// Income, Loans) and that it agrees with Budget vs actual. All the data is made up (bank 99).
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

/**
 * The Worker's own handler with a database that records what the request does to it: the SQL of each statement prepared, and the rows each statement
 * of a batch read (D1 reports them with the result). ADR 0004 allows 50 statements to an invocation and bills rows read.
 */
async function measured(path: string) {
  const watched = { prepared: [] as string[], batchReads: [] as number[] }
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          watched.prepared.push(sql)
          return target.prepare(sql)
        }
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements)
          watched.batchReads.push(...results.map((result) => (result.meta as { rows_read: number }).rows_read))
          return results
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ctx = createExecutionContext()
  const res = await worker.fetch!(new Request(`${origin}${path}`, { headers: { Cookie: 'fernledger_dev_as=member' } }) as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return { res, watched }
}

const tx = (id: string, date: string, amountCents: number) => ({ date, uniqueId: id, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE SHOP ${id}`, bankMemo: 'EFTPOS', amountCents })

type ImportOptions = { number?: string; ledger: [string, number]; from?: string; to?: string; cutoverDate?: string }
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

const accountId = async (number: string) => (await env.DB.prepare('SELECT id FROM accounts WHERE account_number = ?').bind(number).first<{ id: number }>())!.id
const netWorth = async (who: Who = 'member'): Promise<NetWorth> => {
  const res = await call('/api/charts/net-worth', { who })
  expect(res.status).toBe(200)
  return res.json()
}
const spending = async (query: string, who: Who = 'member'): Promise<SpendingByCategory> => {
  const res = await call(`/api/charts/spending?${query}`, { who })
  expect(res.status, query).toBe(200)
  return res.json()
}
type Point = { date: string; balanceCents: number }
const historyOf = async (number: string): Promise<Point[]> => ((await (await call(`/api/balances/${await accountId(number)}/history`)).json()) as { points: Point[] }).points
/** An Account's balance at the end of `date` from its balance history: the last point on or before it, else the balance it opened with. */
const balanceOn = (points: Point[], opening: number, date: string) => points.filter((p) => p.date <= date).at(-1)?.balanceCents ?? opening

beforeEach(async () => {
  await env.DB.batch(['budgets', 'balance_checks', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Net worth

// Savings: $100.00 before its first Transaction. July leaves $140.00 on the 31st, August $120.00, September (no Transactions) the same, and October's
// two leave $123.00 on 7 October, the date of the bank's last balance. Cheque begins in September with $500.00 before its first Transaction, and
// ends on 3 October with $502.23.
const july = [tx('J1', '2026-07-10', 5000), tx('J2', '2026-07-31', -1000)]
const august = [tx('A1', '2026-08-15', -2000)]
const october = [tx('O1', '2026-10-05', -100), tx('O2', '2026-10-06', 400)]
const SAVINGS_TO_OCT_7 = OPENING + 5000 - 1000 - 2000 - 100 + 400
const CHEQUE_OPENING = 50_000
const chequeRows = [tx('X1', '2026-09-12', -777), tx('X2', '2026-10-03', 1000)]
const CHEQUE_TO_OCT_3 = CHEQUE_OPENING - 777 + 1000
const importBoth = async () => {
  await importFile([...july, ...august, ...october], { ledger: ['2026-10-07', SAVINGS_TO_OCT_7] })
  await importFile(chequeRows, { number: cheque, ledger: ['2026-10-03', CHEQUE_TO_OCT_3], from: '2026-09-01' })
}

describe('net worth over time', () => {
  it('is nothing for a Fernledger with no Accounts', async () => {
    expect(await netWorth()).toEqual({ counted: [], notCounted: [], points: [], tooManyAccounts: null })
  })

  it('adds the Accounts\' balances at the end of each month, carries a month with no Transactions, and ends on the last date held', async () => {
    await importBoth()

    const result = await netWorth()

    expect(result.points).toEqual([
      { date: '2026-07-31', cents: 14_000 + CHEQUE_OPENING }, // cheque has not begun: it counts at the balance it opened with
      { date: '2026-08-31', cents: 12_000 + CHEQUE_OPENING },
      { date: '2026-09-30', cents: 12_000 + (CHEQUE_OPENING - 777) },
      { date: '2026-10-07', cents: 12_300 + CHEQUE_TO_OCT_3 }, // the last date held, not the end of October
    ])
    expect(result.counted).toHaveLength(2)
    expect(result.notCounted).toEqual([])
    expect(result.tooManyAccounts).toBeNull()
  })

  it('holds every point to the Accounts\' balance history, and the last to their balances now', async () => {
    await importBoth()
    const [savingsHistory, chequeHistory] = [await historyOf(savings), await historyOf(cheque)]

    const { points } = await netWorth()

    expect(points.length).toBeGreaterThan(3)
    for (const point of points) {
      const expected = balanceOn(savingsHistory, OPENING, point.date) + balanceOn(chequeHistory, CHEQUE_OPENING, point.date)
      expect(point.cents, point.date).toBe(expected)
    }
    const now = ((await (await call('/api/balances')).json()) as { accounts: { balanceCents: number }[] }).accounts
    expect(points.at(-1)!.cents).toBe(now.reduce((sum, a) => sum + a.balanceCents, 0))
  })

  it('names the Accounts, and is the same for a Member as for the Admin', async () => {
    await importBoth()

    const asMember = await netWorth('member')

    expect(asMember).toEqual(await netWorth('admin'))
    const names = (await env.DB.prepare('SELECT id, name FROM accounts ORDER BY name').all<{ id: number; name: string }>()).results
    expect(asMember.counted).toEqual(names.map((a) => ({ accountId: a.id, accountName: a.name })))
  })

  it('leaves out an Account with no bank balance to work from, says so, and totals the rest', async () => {
    await importFile(july, { ledger: ['2026-10-01', 14_000], cutoverDate: '2026-10-01' }) // its only balance is on its Cutover Date: not counted
    await importFile(chequeRows, { number: cheque, ledger: ['2026-10-03', CHEQUE_TO_OCT_3], from: '2026-09-01' })

    const result = await netWorth()

    expect(result.notCounted).toEqual([{ accountId: await accountId(savings), accountName: expect.any(String) }])
    expect(result.counted).toEqual([{ accountId: await accountId(cheque), accountName: expect.any(String) }])
    expect(result.points).toEqual([
      { date: '2026-09-30', cents: CHEQUE_OPENING - 777 },
      { date: '2026-10-03', cents: CHEQUE_TO_OCT_3 },
    ])
  })

  it('has no points when no Account has a bank balance to work from', async () => {
    await importFile(july, { ledger: ['2026-10-01', 14_000], cutoverDate: '2026-10-01' })

    const result = await netWorth()

    expect(result.points).toEqual([])
    expect(result.counted).toEqual([])
    expect(result.notCounted).toHaveLength(1)
  })

  it('counts each leg of a Transfer in its Account\'s balance, as the balances do: moving money between the Accounts does not change net worth', async () => {
    // $50.00 moves from savings ($100.00 before) to cheque ($20.00 before) on 10 August. Each file's balance is after it.
    await importFile([tx('T1', '2026-08-10', -5000)], { ledger: ['2026-08-31', 5000], from: '2026-08-01' })
    await importFile([tx('T2', '2026-08-10', 5000)], { number: cheque, ledger: ['2026-08-31', 7000], from: '2026-08-01' })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE transfer_of IS NOT NULL').first<{ n: number }>())!.n).toBe(2) // paired, or the test means little

    expect((await netWorth()).points).toEqual([{ date: '2026-08-31', cents: 5000 + 7000 }])
  })

  it('is refused for a stranger, and no one can change it', async () => {
    expect((await call('/api/charts/net-worth', { who: null })).status).toBe(401)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call('/api/charts/net-worth', { who: 'member', method, body: {} })).status, method).toBe(403)
    }
    expect((await call('/api/charts/net-worth', { who: 'member', method: 'POST' })).status).toBe(403) // not even with no body
  })
})

describe('net worth\'s cost (ADR 0004)', () => {
  const addAccounts = async (count: number) => {
    await env.DB.batch(Array.from({ length: count }, (_, i) => env.DB.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?)').bind(`99-9999-9999999-${String(i).padStart(2, '0')}`, `Example account ${i}`)))
  }

  it('uses one statement for the list and one for each Account: 50 with the most Accounts it reads, which the free plan allows', async () => {
    await addAccounts(MAX_NET_WORTH_ACCOUNTS)

    const { res, watched } = await measured('/api/charts/net-worth')

    const body = (await res.json()) as NetWorth
    expect(res.status).toBe(200)
    expect(body.tooManyAccounts).toBeNull()
    expect(body.notCounted).toHaveLength(MAX_NET_WORTH_ACCOUNTS) // none has a balance
    expect(watched.prepared).toHaveLength(1 + MAX_NET_WORTH_ACCOUNTS)
    expect(watched.prepared.length).toBeLessThanOrEqual(50)
  })

  it('reads no history, and says so, for more Accounts than that, rather than total some of them', async () => {
    await addAccounts(MAX_NET_WORTH_ACCOUNTS + 1)

    const { res, watched } = await measured('/api/charts/net-worth')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ counted: [], notCounted: [], points: [], tooManyAccounts: { count: MAX_NET_WORTH_ACCOUNTS + 1, limit: MAX_NET_WORTH_ACCOUNTS } })
    expect(watched.prepared).toHaveLength(1) // the list, and no more
    expect(watched.batchReads).toEqual([])
  })

  it('reads a Transaction about six times, as the balances Report does, whatever the dates: the figure ADR 0004 gives', async () => {
    const TRANSACTIONS = [4000, 2000]
    for (const [i, count] of TRANSACTIONS.entries()) {
      await env.DB.prepare('INSERT INTO accounts (id, name, account_number) VALUES (?1, ?2, ?3)').bind(i + 1, `Example account ${i}`, `99-9999-9999999-${i}0`).run()
      await env.DB.prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count})
         INSERT INTO transactions (account_id, date, amount_cents, description, source)
         SELECT ?1, date('2010-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import' FROM seq`,
      )
        .bind(i + 1)
        .run()
      await env.DB.prepare("INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (?1, '2015-01-01', 123456, 'import', (SELECT MAX(id) FROM transactions), 'alone')").bind(i + 1).run()
    }

    const { res, watched } = await measured('/api/charts/net-worth')

    const body = (await res.json()) as NetWorth
    expect(body.counted).toHaveLength(2)
    expect(body.points.length).toBeGreaterThan(40) // about four years of months, so the bounds below are not about an empty answer
    expect(watched.prepared).toHaveLength(1 + 2)
    expect(watched.batchReads).toHaveLength(2)
    for (const [i, count] of TRANSACTIONS.entries()) {
      expect(watched.batchReads[i]!, `account ${i}`).toBeGreaterThan(count * 4) // so the bound below is about the Transactions, not slack
      expect(watched.batchReads[i]!, `account ${i}`).toBeLessThanOrEqual(count * 7 + 100)
    }
  })

  it('asks the history of every date, so no month of any Transaction is left out', () => {
    expect(EVERY_DATE.from < '2000-01-01' && EVERY_DATE.to > '2100-12-31').toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Spending by Category

let accountA = 0
let accountB = 0
const ids: Record<string, number> = {}
type Extra = { override?: string; rule?: string; ruleTransfer?: boolean }

async function add(account: number, date: string, amountCents: number, extra: Extra = {}) {
  const { meta } = await env.DB.prepare(
    'INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category, rule_transfer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(account, date, amountCents, 'EXAMPLE SHOP', 'import', extra.override ? ids[extra.override]! : null, extra.rule ? ids[extra.rule]! : null, extra.ruleTransfer ? 1 : null)
    .run()
  return meta.last_row_id
}

/** Two Transactions that are each other's matching Transaction: a paired Transfer. */
async function pair(date: string, amountCents: number) {
  const out = await add(accountA, date, -amountCents)
  const into = await add(accountB, date, amountCents)
  await env.DB.batch([env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(into, out), env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(out, into)])
}

describe('spending by Category', () => {
  beforeEach(async () => {
    const [a, b] = await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
      env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example savings') RETURNING id"),
    ])
    accountA = (a!.results[0] as { id: number }).id
    accountB = (b!.results[0] as { id: number }).id
    for (const name of ['Groceries', 'Fuel', 'Eating out', 'Wages and salary', 'Loans']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
  })

  const figures = (result: SpendingByCategory) => result.categories.map((c) => [c.name, c.cents])

  it('totals each Spending Category over the dates, the most first, with a refund coming off', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', -1550, { override: 'Groceries' })
    await add(accountA, '2026-10-21', 1000, { override: 'Groceries' }) // a refund
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-09-30', -777, { override: 'Groceries' }) // the day before

    const result = await spending('from=2026-10-01&to=2026-10-31')

    expect(figures(result)).toEqual([['Fuel', 9000], ['Groceries', 4550]])
    expect(result).toMatchObject({ from: '2026-10-01', to: '2026-10-31', totalCents: 9000 + 4550 })
    expect(result.categories[0]).toEqual({ categoryId: ids['Fuel'], name: 'Fuel', cents: 9000 })
  })

  it('adds a Category\'s months together, and takes its first and last days into the dates', async () => {
    await add(accountA, '2026-08-31', -100, { override: 'Fuel' }) // before
    await add(accountA, '2026-09-01', -200, { override: 'Fuel' }) // the first day
    await add(accountA, '2026-10-31', -400, { override: 'Fuel' }) // the last day
    await add(accountA, '2026-11-01', -800, { override: 'Fuel' }) // after

    expect(figures(await spending('from=2026-09-01&to=2026-10-31'))).toEqual([['Fuel', 600]])
    expect(figures(await spending('from=2026-09-01&to=2026-09-01'))).toEqual([['Fuel', 200]]) // one day
  })

  it('leaves out Transfers between the Accounts, however they are found, so only spending is shown', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await pair('2026-10-03', 100_000) // $1,000.00 moved from one Account to the other
    await add(accountA, '2026-10-04', -2500, { ruleTransfer: true }) // a Rule marks it a Transfer with no pair
    await add(accountA, '2026-10-06', -1200, { rule: 'Fuel', ruleTransfer: true }) // a Transfer shows no Category, whatever a Rule gave it

    const result = await spending('from=2026-10-01&to=2026-10-31')

    expect(figures(result)).toEqual([['Groceries', 4000]])
    expect(result.totalCents).toBe(4000)
  })

  it('leaves out Income and Loans, and counts Uncategorised, with its own name and no Category', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-03', 500_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-04', -20_000, { override: 'Loans' }) // money lent: neither Spending nor Income
    await add(accountA, '2026-10-05', -3000)

    const result = await spending('from=2026-10-01&to=2026-10-31')

    expect(figures(result)).toEqual([['Groceries', 4000], ['Uncategorised', 3000]])
    expect(result.categories[1]!.categoryId).toBeNull()
    expect(result.totalCents).toBe(7000)
  })

  it('puts a Category that took in more than it paid out last, below zero, and counts it in the total', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-03', 2500, { override: 'Fuel' })

    const result = await spending('from=2026-10-01&to=2026-10-31')

    expect(figures(result)).toEqual([['Groceries', 4000], ['Fuel', -2500]])
    expect(result.totalCents).toBe(1500)
  })

  it('counts a Transaction in a removed Category as the next Category names, or Uncategorised', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -1000, { override: 'Fuel' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()

    expect(figures(await spending('from=2026-10-01&to=2026-10-31'))).toEqual([['Groceries', 4000], ['Uncategorised', 1000]])
  })

  it('is empty when there is no spending, with the dates it was asked for', async () => {
    expect(await spending('from=2026-10-01&to=2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31', totalCents: 0, categories: [] })
  })

  it('agrees with Budget vs actual for the same month: no second definition of what was spent', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', 1000, { override: 'Groceries' })
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-10-06', -700, { override: 'Eating out' }) // no Budget: it is in "the rest"
    await add(accountA, '2026-10-09', -300) // Uncategorised
    await pair('2026-10-07', 5000)
    await add(accountA, '2026-10-08', 400_000, { override: 'Wages and salary' })
    for (const name of ['Groceries', 'Fuel']) {
      expect((await call(`/api/budgets/${ids[name]}`, { method: 'PUT', body: { effectiveFrom: '2026-10', amountCents: 50_000 } })).status).toBe(200)
    }

    const vsActual = (await (await call('/api/budgets/vs-actual?month=2026-10')).json()) as { rows: { categoryId: number; spentCents: number }[]; otherCents: number; uncategorisedCents: number }
    const chart = await spending('from=2026-10-01&to=2026-10-31')

    expect(vsActual.rows).toHaveLength(2)
    for (const row of vsActual.rows) expect(chart.categories.find((c) => c.categoryId === row.categoryId)?.cents, String(row.categoryId)).toBe(row.spentCents)
    expect(chart.categories.find((c) => c.name === 'Eating out')?.cents).toBe(vsActual.otherCents)
    expect(chart.categories.find((c) => c.categoryId === null)?.cents).toBe(vsActual.uncategorisedCents)
    expect(chart.totalCents).toBe(vsActual.rows.reduce((sum, r) => sum + r.spentCents, 0) + vsActual.otherCents + vsActual.uncategorisedCents)
  })

  describe('named periods', () => {
    // Today's NZ month decides them, so the Transactions are dated from it: $0.01 this month, $0.10 last month, and so on by tens.
    const month = nzMonth(new Date())
    const spend = (monthsAgo: number, cents: number) => add(accountA, `${monthsBefore(month, monthsAgo)}-15`, -cents, { override: 'Fuel' })

    beforeEach(async () => {
      await spend(0, 1)
      await spend(1, 10)
      await spend(2, 100)
      await spend(3, 1000)
      await spend(11, 10_000)
      await spend(12, 100_000)
    })

    it.each([
      ['this-month', 0, 0, 1],
      ['last-month', 1, 1, 10],
      ['past-3-months', 2, 0, 111],
      ['past-12-months', 11, 0, 11_111],
    ] as const)('%s runs from %i months ago to %i months ago, whole NZ months, and totals what is in them', async (period, fromAgo, toAgo, cents) => {
      const result = await spending(`period=${period}`)

      expect(result).toMatchObject({ from: monthStart(monthsBefore(month, fromAgo)), to: monthEnd(monthsBefore(month, toAgo)), totalCents: cents })
    })
  })

  it('refuses a bad query and names only the field', async () => {
    const cases: [string, string][] = [
      ['', 'period'],
      ['period=this-year', 'period'],
      ['period=this-month&from=2026-10-01', 'period'],
      ['from=2026-10-01', 'to'],
      ['to=2026-10-31', 'from'],
      ['from=2026-10-31&to=2026-10-01', 'to'],
      ['from=2026-02-30&to=2026-03-01', 'from'],
      ['from=2026-10-01&to=EXAMPLE-SHOP-NAME', 'to'],
    ]
    for (const [query, field] of cases) {
      const res = await call(`/api/charts/spending?${query}`)
      expect(res.status, query).toBe(400)
      const text = await res.text()
      expect(JSON.parse(text), query).toEqual({ error: 'Invalid request', field })
      expect(text).not.toContain('EXAMPLE-SHOP-NAME') // the value is never echoed
    }
  })

  it('is refused for a stranger, readable by a Member and the Admin, and not writable by anyone', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })

    expect((await call('/api/charts/spending?period=this-month', { who: null })).status).toBe(401)
    expect(figures(await spending('from=2026-10-01&to=2026-10-31', 'member'))).toEqual([['Groceries', 4000]])
    expect(figures(await spending('from=2026-10-01&to=2026-10-31', 'admin'))).toEqual([['Groceries', 4000]])
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call('/api/charts/spending?period=this-month', { who: 'member', method, body: {} })).status, method).toBe(403)
    }
  })
})

describe('spending by Category\'s cost (ADR 0004)', () => {
  const TRANSACTIONS = 6000

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO accounts (id, name, account_number) VALUES (1, 'Example everyday', ?)").bind(savings).run()
    // A year of days, 6,000 Transactions in all, each with an Override.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT 1, date('2025-10-01', '+' || (i % 365) || ' days'), -100, 'EXAMPLE ' || i, 'import', (SELECT id FROM categories WHERE name = 'Groceries') FROM seq`,
    ).run()
  })

  const inDates = async (from: string, to: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE date >= ? AND date <= ?').bind(from, to).first<{ n: number }>())!.n

  it('uses two statements however long the dates are, and reads the dates asked for and not the history around them', async () => {
    const month = await measured('/api/charts/spending?from=2026-04-01&to=2026-04-30')
    const year = await measured('/api/charts/spending?from=2000-01-01&to=2100-12-31')

    expect(month.res.status).toBe(200)
    expect(year.res.status).toBe(200)
    expect(month.watched.prepared).toHaveLength(2)
    expect(year.watched.prepared).toHaveLength(2)
    const [monthRows, monthNames] = month.watched.batchReads as [number, number]
    const [yearRows] = year.watched.batchReads as [number, number]
    const inMonth = await inDates('2026-04-01', '2026-04-30')
    expect(inMonth).toBeGreaterThan(400)
    expect(monthRows).toBeGreaterThan(inMonth * 2) // so the bound below is about the Transactions, not slack
    expect(monthRows).toBeLessThanOrEqual(inMonth * 4 + 50) // ADR 0004: three reads for each, four when a Rule names the Category too
    expect(yearRows).toBeLessThanOrEqual(TRANSACTIONS * 4 + 50)
    expect(monthRows).toBeLessThan(yearRows / 5) // a month does not read the year
    expect(monthNames).toBeLessThanOrEqual(100) // the Categories in use: a few dozen
  })
})
