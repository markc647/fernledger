import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_REPORT_MONTHS as PAGE_MAX_REPORT_MONTHS } from '../src/lib/report-budget'
import type { Change, InEffect } from './budget-rules'
import worker from './index'
import { nzMonth } from './months'
import { budgetReport, MAX_REPORT_MONTHS, type BudgetReport } from './report-budget'
import type { SpendingRow } from './spending'

// Seam 1: the Budget vs actual Report's data (GET /api/reports/budget-vs-actual), through the Worker's exported handler as the local-development Admin or a
// read-only Member (the dev identity cookie is honoured on localhost only). The Report is Budgets and Spending put side by side for many months, so the
// main tests hold each of its months to the Summary's Budget vs actual (GET /api/budgets/vs-actual) and its total to the spending chart's. Spending is
// imported the way the Admin does it, so Rules and Transfer pairing are the real ones. All the data is made up (bank 99).
const origin = 'http://localhost:5173'

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
 * The Worker's own handler with a database that records what the request does to it: the SQL of each statement prepared, and the rows each statement read
 * (D1 reports them with the result), in the order the statements finished. ADR 0004 allows 50 statements to an invocation and bills rows read. (The same as
 * charts.test.ts's: a test file's helpers can't be shared, because the production Worker's compiler would meet `cloudflare:test`.)
 */
async function measured(path: string) {
  const watched = { prepared: [] as string[], reads: [] as number[] }
  const rowsRead = (result: { meta: unknown }) => (result.meta as { rows_read: number }).rows_read
  const real = new WeakMap<object, D1PreparedStatement>()
  const track = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property === 'bind') return (...binds: unknown[]) => track(target.bind(...binds))
        if (property === 'all' || property === 'run') {
          return async () => {
            const result = await (value as () => Promise<{ meta: unknown }>).call(target)
            watched.reads.push(rowsRead(result))
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    real.set(proxy, statement)
    return proxy
  }
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          watched.prepared.push(sql)
          return track(target.prepare(sql))
        }
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((statement) => real.get(statement) ?? statement))
          watched.reads.push(...results.map(rowsRead))
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

const ids: Record<string, number> = {}
const NAMES = ['Groceries', 'Fuel', 'Eating out', 'Travel', 'Wages and salary', 'Loans']

const report = async (from: string, to: string, who: Who = 'member'): Promise<BudgetReport> => {
  const res = await call(`/api/reports/budget-vs-actual?from=${from}&to=${to}`, { who })
  expect(res.status, `${from} to ${to}`).toBe(200)
  return res.json()
}
type VsActual = { month: string; rows: BudgetReport['months'][number]['rows']; otherCents: number; uncategorisedCents: number }
const vsActual = async (month: string): Promise<VsActual> => (await call(`/api/budgets/vs-actual?month=${month}`)).json()
/** What the spending chart says the Spending Categories spent in all, over the same dates: spending.ts's own total. */
const chartTotal = async (from: string, to: string): Promise<number> => ((await (await call(`/api/charts/spending?from=${from}&to=${to}`)).json()) as { totalCents: number }).totalCents
/** A month's rows as `[Category, Budget, Spent]`, to read at a glance. */
const glance = (month: BudgetReport['months'][number]) => month.rows.map((r) => [r.categoryName, r.budgetCents, r.spentCents])

const set = (name: string, effectiveFrom: string, amountCents: number | null) => call(`/api/budgets/${ids[name]}`, { method: 'PUT', body: { effectiveFrom, amountCents } })
const mustSet = async (name: string, effectiveFrom: string, amountCents: number | null) => {
  const res = await set(name, effectiveFrom, amountCents)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}

const EVERYDAY = { number: '99-9999-9999999-01', name: 'Everyday' }
const SAVINGS = { number: '99-9999-9999999-02', name: 'Savings' }
type Account = typeof EVERYDAY
let serial = 0
const row = (date: string, amountCents: number, payee: string, uniqueId = `R${++serial}`) => ({ date, uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee, bankMemo: '', amountCents })
async function importInto(account: Account, rows: ReturnType<typeof row>[]) {
  const dates = rows.map((r) => r.date).sort()
  const res = await call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account,
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: dates[0], to: dates.at(-1), ledgerBalance: { cents: 0, date: dates.at(-1) } },
      rows,
    },
  })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}
const rule = async (textContains: string, category: string) => {
  const res = await call('/api/rules', { method: 'POST', body: { textContains, categoryId: ids[category] } })
  expect(res.status).toBe(201)
}

beforeEach(async () => {
  serial = 0
  await env.DB.batch(['budgets', 'balance_checks', 'transactions', 'rules', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare(
    "UPDATE categories SET removed_at = NULL, kind = CASE WHEN name IN ('Wages and salary', 'NZ Super and benefits', 'Interest', 'Other income') THEN 'income' WHEN name = 'Loans' THEN 'loans' ELSE 'spending' END",
  ).run()
  for (const name of NAMES) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

// A year's worth of everything the Report has to get right, from January to April 2026:
// - Eating out has $150.00 from January, ended from April; Fuel has $200.00 from February; Groceries has $800.00 from January;
// - Fuel in January has no Budget yet and Eating out in April has none any more, so that spending is outside Budgets;
// - February has a refund and wages ($2,000.00, Income) and money lent ($500.00, Loans); March has money in with no Category, so Uncategorised is below zero;
// - April has a Transfer of $300.00 between the two Accounts, which is neither spending nor income.
async function seedYear() {
  for (const [text, category] of [
    ['EXAMPLE COUNTDOWN', 'Groceries'],
    ['EXAMPLE BP', 'Fuel'],
    ['EXAMPLE CAFE', 'Eating out'],
    ['EXAMPLE WAGES', 'Wages and salary'],
    ['EXAMPLE LENDING', 'Loans'],
  ] as const)
    await rule(text, category)
  await mustSet('Groceries', '2026-01', 80_000)
  await mustSet('Eating out', '2026-01', 15_000)
  await mustSet('Fuel', '2026-02', 20_000)
  await mustSet('Eating out', '2026-04', null)
  await importInto(EVERYDAY, [
    row('2026-01-05', -70_000, 'EXAMPLE COUNTDOWN'),
    row('2026-01-20', -5_000, 'EXAMPLE COUNTDOWN'),
    row('2026-01-12', -6_000, 'EXAMPLE BP'),
    row('2026-01-15', -4_000, 'EXAMPLE CAFE'),
    row('2026-01-25', -1_234, 'EXAMPLE DAIRY'),
    row('2026-02-03', -80_000, 'EXAMPLE COUNTDOWN'),
    row('2026-02-17', 3_000, 'EXAMPLE COUNTDOWN REFUND'),
    row('2026-02-10', -18_000, 'EXAMPLE BP'),
    row('2026-02-14', 200_000, 'EXAMPLE WAGES'),
    row('2026-02-20', -50_000, 'EXAMPLE LENDING'),
    row('2026-03-04', -95_000, 'EXAMPLE COUNTDOWN'),
    row('2026-03-09', -21_000, 'EXAMPLE BP'),
    row('2026-03-12', -15_100, 'EXAMPLE CAFE'),
    row('2026-03-30', 2_000, 'EXAMPLE DAIRY REFUND'),
    row('2026-04-02', -10_000, 'EXAMPLE COUNTDOWN'),
    row('2026-04-08', -6_000, 'EXAMPLE CAFE'),
    row('2026-04-15', -30_000, 'EXAMPLE TFR TO SAVINGS'),
  ])
  await importInto(SAVINGS, [row('2026-04-15', 30_000, 'EXAMPLE TFR FROM EVERYDAY')])
}

describe('the Budget a month has in the Report', () => {
  it('is the latest change on or before the month: none before the first, the new amount from the month it changes, none from the month it ends, and again when one follows', async () => {
    await rule('EXAMPLE COUNTDOWN', 'Groceries')
    await mustSet('Groceries', '2026-02', 80_000)
    await mustSet('Groceries', '2026-04', 90_000)
    await mustSet('Groceries', '2026-06', null)
    await mustSet('Groceries', '2026-08', 50_000)
    await importInto(EVERYDAY, [
      row('2026-01-10', -1_000, 'EXAMPLE COUNTDOWN'),
      row('2026-02-10', -70_000, 'EXAMPLE COUNTDOWN'),
      row('2026-04-10', -95_000, 'EXAMPLE COUNTDOWN'),
      row('2026-06-10', -2_000, 'EXAMPLE COUNTDOWN'),
      row('2026-08-10', -51_000, 'EXAMPLE COUNTDOWN'),
    ])

    const r = await report('2026-01-01', '2026-09-30')

    expect(r.months.map((m) => [m.month, glance(m), m.otherCents])).toEqual([
      ['2026-01', [], 1_000], // before the first change: no Budget, so what was spent is outside Budgets
      ['2026-02', [['Groceries', 80_000, 70_000]], 0],
      ['2026-03', [['Groceries', 80_000, 0]], 0], // the Budget stays the same through the months until it changes
      ['2026-04', [['Groceries', 90_000, 95_000]], 0], // the new amount from the month it is effective from
      ['2026-05', [['Groceries', 90_000, 0]], 0],
      ['2026-06', [], 2_000], // ended from June
      ['2026-07', [], 0],
      ['2026-08', [['Groceries', 50_000, 51_000]], 0], // and starts again
      ['2026-09', [['Groceries', 50_000, 0]], 0],
    ])
  })

  it('is the same whether the Admin set the later change first, and a change made now leaves the months before it as they were', async () => {
    await mustSet('Groceries', '2026-04', 90_000)
    await mustSet('Groceries', '2026-01', 80_000)
    const before = await report('2026-01-01', '2026-03-31')

    await mustSet('Groceries', '2026-05', 10_000)

    expect(before.months.map((m) => glance(m))).toEqual([[['Groceries', 80_000, 0]], [['Groceries', 80_000, 0]], [['Groceries', 80_000, 0]]])
    expect((await report('2026-01-01', '2026-03-31')).months).toEqual(before.months)
    expect((await report('2026-04-01', '2026-06-30')).months.map((m) => glance(m))).toEqual([[['Groceries', 90_000, 0]], [['Groceries', 10_000, 0]], [['Groceries', 10_000, 0]]])
  })

  it('does not carry anything over: what a Category did not spend, or overspent, in one month changes nothing in the next', async () => {
    await rule('EXAMPLE COUNTDOWN', 'Groceries')
    await mustSet('Groceries', '2026-01', 50_000)
    await importInto(EVERYDAY, [row('2026-01-10', -20_000, 'EXAMPLE COUNTDOWN'), row('2026-02-10', -70_000, 'EXAMPLE COUNTDOWN'), row('2026-03-10', -10_000, 'EXAMPLE COUNTDOWN')])

    const r = await report('2026-01-01', '2026-03-31')

    expect(r.months.map(glance)).toEqual([[['Groceries', 50_000, 20_000]], [['Groceries', 50_000, 70_000]], [['Groceries', 50_000, 10_000]]])
  })
})

describe('the Report’s months and the Summary’s Budget vs actual', () => {
  it('are the same figures: each month has the rows, Spending outside Budgets and Uncategorised that the Summary shows for it', async () => {
    await seedYear()

    const r = await report('2026-01-01', '2026-04-30')

    expect(r.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    for (const month of r.months) {
      const summary = await vsActual(month.month)
      expect({ rows: month.rows, otherCents: month.otherCents, uncategorisedCents: month.uncategorisedCents }, month.month).toEqual({
        rows: summary.rows,
        otherCents: summary.otherCents,
        uncategorisedCents: summary.uncategorisedCents,
      })
    }
  })

  it('come out as worked by hand: the Budget in each month against Spending, a refund taken off, Uncategorised below zero, and what has no Budget outside', async () => {
    await seedYear()

    const r = await report('2026-01-01', '2026-04-30')

    expect(r.months.map((m) => [m.month, glance(m), m.otherCents, m.uncategorisedCents, m.budgetCents, m.spentCents])).toEqual([
      ['2026-01', [['Eating out', 15_000, 4_000], ['Groceries', 80_000, 75_000]], 6_000, 1_234, 95_000, 86_234], // Fuel has no Budget yet: its $60.00 is outside Budgets
      ['2026-02', [['Eating out', 15_000, 0], ['Fuel', 20_000, 18_000], ['Groceries', 80_000, 77_000]], 0, 0, 115_000, 95_000], // $800.00 out less a $30.00 refund; wages and the loan are not spending
      ['2026-03', [['Eating out', 15_000, 15_100], ['Fuel', 20_000, 21_000], ['Groceries', 80_000, 95_000]], 0, -2_000, 115_000, 129_100], // money in with no Category comes off Uncategorised
      ['2026-04', [['Fuel', 20_000, 0], ['Groceries', 80_000, 10_000]], 6_000, 0, 100_000, 16_000], // Eating out's Budget has ended: its $60.00 is outside Budgets
    ])
  })
})

describe('the Report’s totals', () => {
  it('add up in every month: the Categories with a Budget, Spending outside Budgets and Uncategorised are the month’s total spending', async () => {
    await seedYear()

    for (const month of (await report('2026-01-01', '2026-04-30')).months) {
      const parts = month.rows.reduce((sum, r) => sum + r.spentCents, 0) + month.otherCents + month.uncategorisedCents
      expect(parts, month.month).toBe(month.spentCents)
      expect(month.rows.reduce((sum, r) => sum + r.budgetCents, 0), month.month).toBe(month.budgetCents)
    }
  })

  it('are the spending chart’s total for the same dates, which the months add up to', async () => {
    await seedYear()

    const r = await report('2026-01-01', '2026-04-30')

    expect(r.total.spentCents).toBe(326_334)
    expect(r.total.spentCents).toBe(await chartTotal('2026-01-01', '2026-04-30'))
    expect(r.months.reduce((sum, m) => sum + m.spentCents, 0)).toBe(r.total.spentCents)
  })

  it('add up over all the months: each Category’s Budgets and spending while it had a Budget, with the rest outside, are the total', async () => {
    await seedYear()

    const r = await report('2026-01-01', '2026-04-30')

    expect(r.categories).toEqual([
      { categoryId: ids['Eating out'], categoryName: 'Eating out', months: 3, budgetCents: 45_000, spentCents: 19_100 },
      { categoryId: ids['Fuel'], categoryName: 'Fuel', months: 3, budgetCents: 60_000, spentCents: 39_000 },
      { categoryId: ids['Groceries'], categoryName: 'Groceries', months: 4, budgetCents: 320_000, spentCents: 257_000 },
    ])
    expect(r.total).toEqual({ budgetCents: 425_000, spentCents: 326_334, otherCents: 12_000, uncategorisedCents: -766 })
    expect(r.categories.reduce((sum, c) => sum + c.spentCents, 0) + r.total.otherCents + r.total.uncategorisedCents).toBe(r.total.spentCents)
    expect(r.categories.reduce((sum, c) => sum + c.budgetCents, 0)).toBe(r.total.budgetCents)
    expect(r.months.reduce((sum, m) => sum + m.budgetCents, 0)).toBe(r.total.budgetCents)
  })

  it('leave out a Transfer, wages and money lent: a $300.00 Transfer, $2,000.00 of wages and $500.00 lent change nothing', async () => {
    await mustSet('Groceries', '2026-04', 80_000)
    await rule('EXAMPLE COUNTDOWN', 'Groceries')
    await rule('EXAMPLE WAGES', 'Wages and salary')
    await rule('EXAMPLE LENDING', 'Loans')
    await importInto(EVERYDAY, [row('2026-04-02', -4_000, 'EXAMPLE COUNTDOWN'), row('2026-04-03', 200_000, 'EXAMPLE WAGES'), row('2026-04-04', -50_000, 'EXAMPLE LENDING'), row('2026-04-15', -30_000, 'EXAMPLE TFR')])
    await importInto(SAVINGS, [row('2026-04-15', 30_000, 'EXAMPLE TFR')])

    const r = await report('2026-04-01', '2026-04-30')

    expect(r.months[0]).toMatchObject({ rows: [{ categoryName: 'Groceries', budgetCents: 80_000, spentCents: 4_000 }], otherCents: 0, uncategorisedCents: 0, spentCents: 4_000 })
    expect(r.total.spentCents).toBe(4_000)
  })

  it('count a Transfer half the Admin gave a Category, as Spending does, and not its matching Transaction', async () => {
    await mustSet('Groceries', '2026-04', 80_000)
    await importInto(EVERYDAY, [row('2026-04-15', -30_000, 'EXAMPLE TFR', 'OUT')])
    await importInto(SAVINGS, [row('2026-04-15', 30_000, 'EXAMPLE TFR', 'IN')])
    const out = (await env.DB.prepare("SELECT id FROM transactions WHERE bank_unique_id = 'OUT'").first<{ id: number }>())!.id
    expect((await call(`/api/transactions/${out}/override`, { method: 'PUT', body: { categoryId: ids['Groceries'] } })).status).toBe(200)

    expect((await report('2026-04-01', '2026-04-30')).months[0]!.rows).toEqual([{ categoryId: ids['Groceries'], categoryName: 'Groceries', budgetCents: 80_000, spentCents: 30_000 }])
  })

  it('take a refund off a Category’s spending, and show one that took in more than it paid out below zero', async () => {
    await mustSet('Groceries', '2026-04', 80_000)
    await rule('EXAMPLE COUNTDOWN', 'Groceries')
    await importInto(EVERYDAY, [row('2026-04-02', -2_000, 'EXAMPLE COUNTDOWN'), row('2026-04-09', 3_500, 'EXAMPLE COUNTDOWN REFUND')])

    const r = await report('2026-04-01', '2026-04-30')

    expect(glance(r.months[0]!)).toEqual([['Groceries', 80_000, -1_500]])
    expect(r.months[0]!.spentCents).toBe(-1_500)
    expect(r.total.spentCents).toBe(-1_500)
  })
})

describe('the months a Report covers', () => {
  it('are every month the dates touch, whole: a Transaction on the first or last day of the first or last month is in, one a day outside them is not', async () => {
    await mustSet('Groceries', '2026-01', 80_000)
    await rule('EXAMPLE COUNTDOWN', 'Groceries')
    await importInto(EVERYDAY, [
      row('2026-01-31', -100, 'EXAMPLE COUNTDOWN'),
      row('2026-02-01', -200, 'EXAMPLE COUNTDOWN'),
      row('2026-04-30', -400, 'EXAMPLE COUNTDOWN'),
      row('2026-05-01', -800, 'EXAMPLE COUNTDOWN'),
    ])

    const r = await report('2026-02-15', '2026-04-10')

    expect(r.from).toBe('2026-02-15')
    expect(r.to).toBe('2026-04-10')
    expect(r.covers).toEqual({ from: '2026-02-01', to: '2026-04-30' })
    expect(r.months.map((m) => [m.month, glance(m)])).toEqual([['2026-02', [['Groceries', 80_000, 200]]], ['2026-03', [['Groceries', 80_000, 0]]], ['2026-04', [['Groceries', 80_000, 400]]]])
    expect(r.total.spentCents).toBe(600)
  })

  it('end on the last day of a February in a leap year, and cross a year end', async () => {
    expect((await report('2027-11-20', '2028-02-02')).covers).toEqual({ from: '2027-11-01', to: '2028-02-29' })
    expect((await report('2027-11-20', '2028-02-02')).months.map((m) => m.month)).toEqual(['2027-11', '2027-12', '2028-01', '2028-02'])
    expect((await report('2100-02-01', '2100-02-01')).covers).toEqual({ from: '2100-02-01', to: '2100-02-28' }) // 2100 is not a leap year
  })

  it('include a month with nothing in it, with no Budget and no spending', async () => {
    const r = await report('2026-01-01', '2026-02-28')

    expect(r.months).toEqual([
      { month: '2026-01', rows: [], otherCents: 0, uncategorisedCents: 0, budgetCents: 0, spentCents: 0 },
      { month: '2026-02', rows: [], otherCents: 0, uncategorisedCents: 0, budgetCents: 0, spentCents: 0 },
    ])
    expect(r.categories).toEqual([])
    expect(r.total).toEqual({ budgetCents: 0, spentCents: 0, otherCents: 0, uncategorisedCents: 0 })
  })

  it('are one month for dates in the same month, and as many as 24', async () => {
    expect((await report('2026-03-05', '2026-03-05')).months.map((m) => m.month)).toEqual(['2026-03'])
    expect((await report('2024-01-31', '2025-12-01')).months).toHaveLength(MAX_REPORT_MONTHS)
  })

  it('say which month it is now, in New Zealand, so the Report can say that month is not over', async () => {
    const before = nzMonth(new Date())
    const { thisMonth } = await report('2026-03-05', '2026-03-05')
    expect([before, nzMonth(new Date())]).toContain(thisMonth)
  })
})

describe('the Categories a Report lists', () => {
  it('are the Spending Categories in use: one made Income or Loans keeps its Budget but is not listed or counted, and a removed one is gone', async () => {
    await seedYear()
    expect((await call(`/api/categories/${ids['Fuel']}/kind`, { method: 'PUT', body: { kind: 'income' } })).status).toBe(200)
    expect((await call(`/api/categories/${ids['Eating out']}`, { method: 'DELETE', body: {} })).status).toBe(200)

    const r = await report('2026-02-01', '2026-02-28')

    expect(r.months[0]!.rows.map((x) => x.categoryName)).toEqual(['Groceries'])
    expect(r.categories.map((c) => c.categoryName)).toEqual(['Groceries'])
    expect(r.total.spentCents).toBe(77_000) // Fuel's $180.00 is Income now (money out of an Income Category), not Spending, and the Eating out Category is gone
    expect(r.total.spentCents).toBe(await chartTotal('2026-02-01', '2026-02-28'))
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM budgets WHERE category_id = ?').bind(ids['Fuel']).first()).toEqual({ n: 1 }) // kept
  })

  it('are in the Summary’s order, by name', async () => {
    await mustSet('Travel', '2026-01', 1_000)
    await mustSet('Fuel', '2026-01', 1_000)
    await mustSet('Groceries', '2026-01', 1_000)

    const r = await report('2026-01-01', '2026-02-28')

    expect(r.months[0]!.rows.map((x) => x.categoryName)).toEqual(['Fuel', 'Groceries', 'Travel'])
    expect(r.categories.map((c) => c.categoryName)).toEqual(['Fuel', 'Groceries', 'Travel'])
  })
})

describe('who can read the Report, and what it refuses', () => {
  const path = '/api/reports/budget-vs-actual?from=2026-01-01&to=2026-03-31'
  const refusal = async (query: string) => {
    const res = await call(`/api/reports/budget-vs-actual${query}`)
    return { status: res.status, body: await res.json() }
  }

  it('is open to every Member and to the Admin, with the same figures, and to no one who is not signed in', async () => {
    await seedYear()
    const [member, admin] = await Promise.all([report('2026-01-01', '2026-04-30', 'member'), report('2026-01-01', '2026-04-30', 'admin')])

    expect(member).toEqual({ ...admin, thisMonth: expect.any(String) })
    expect(member.months).toHaveLength(4)
    expect((await call(path, { who: null })).status).toBe(401)
  })

  it('refuses dates that are not two real dates in order, naming the field and never the value', async () => {
    for (const [query, field] of [
      ['', 'from'],
      ['?from=2026-01-01', 'to'],
      ['?to=2026-03-31', 'from'],
      ['?from=abc&to=2026-03-31', 'from'],
      ['?from=2026-02-30&to=2026-03-31', 'from'],
      ['?from=1999-12-31&to=2026-03-31', 'from'],
      ['?from=2026-01-01&to=2101-01-01', 'to'],
      ['?from=2026-01-01&to=2026-3-31', 'to'],
      ['?from=2026-03-31&to=2026-01-01', 'to'],
    ] as const) {
      expect(await refusal(query), query).toEqual({ status: 400, body: { error: 'Invalid request', field } })
    }
  })

  it('refuses dates that touch more than 24 months, naming the later date, and takes exactly 24', async () => {
    expect(await refusal('?from=2024-01-01&to=2026-01-01')).toEqual({ status: 400, body: { error: 'Invalid request', field: 'to' } }) // 25 months
    expect(await refusal('?from=2000-01-01&to=2100-12-31')).toEqual({ status: 400, body: { error: 'Invalid request', field: 'to' } })
    expect((await call('/api/reports/budget-vs-actual?from=2024-01-01&to=2025-12-31')).status).toBe(200) // 24 months
  })

  it('takes no Account: a Budget is for all of them together, so one in the request changes nothing', async () => {
    await seedYear()
    const accountId = (await env.DB.prepare('SELECT id FROM accounts WHERE account_number = ?').bind(SAVINGS.number).first<{ id: number }>())!.id

    const one = await (await call(`${path}&accountId=${accountId}`)).json()
    const all = await (await call(path)).json()

    expect(one).toEqual(all)
  })

  it('has the same limit as the Report page, which asks before it opens a Report it would be refused', () => {
    expect(PAGE_MAX_REPORT_MONTHS).toBe(MAX_REPORT_MONTHS)
  })
})

describe('the Report put together from the rows (no database)', () => {
  const entry = (categoryId: number, categoryName: string): InEffect => ({ categoryId, categoryName, amountCents: null, effectiveFrom: null })
  const change = (categoryId: number, effectiveFrom: string, amountCents: number | null): Change => ({ categoryId, effectiveFrom, amountCents })
  const spent = (month: string, categoryId: number | null, outCents: number, inCents = 0, kind: SpendingRow['kind'] = 'spending'): SpendingRow => ({
    month,
    categoryId,
    categoryName: categoryId === null ? null : `Category ${categoryId}`,
    kind,
    outCents,
    inCents,
  })
  const request = { from: '2026-11-10', to: '2027-02-02' }
  const inEffect = [entry(1, 'Category 1'), entry(2, 'Category 2')]

  it('writes a month for each from the first to the last across a year end, in order, whatever order the rows came in', () => {
    const r = budgetReport(request, { inEffect, changes: [], spending: [spent('2027-02', 1, 100), spent('2026-12', 1, 200)], thisMonth: '2026-12' })

    expect(r.months.map((m) => [m.month, m.otherCents])).toEqual([['2026-11', 0], ['2026-12', 200], ['2027-01', 0], ['2027-02', 100]])
    expect(r.covers).toEqual({ from: '2026-11-01', to: '2027-02-28' })
    expect(r.thisMonth).toBe('2026-12')
  })

  it('lists a Category in the all-months figures only if it had a Budget in some month, and counts the months it had one', () => {
    const r = budgetReport(request, {
      inEffect,
      changes: [change(2, '2026-12', 1_000), change(2, '2027-02', null)],
      spending: [spent('2026-11', 2, 50), spent('2026-12', 2, 300), spent('2027-01', 2, 500), spent('2027-02', 2, 7)],
      thisMonth: '2027-02',
    })

    expect(r.categories).toEqual([{ categoryId: 2, categoryName: 'Category 2', months: 2, budgetCents: 2_000, spentCents: 800 }])
    expect(r.total).toEqual({ budgetCents: 2_000, spentCents: 857, otherCents: 57, uncategorisedCents: 0 }) // November and February are outside Budgets
  })

  it('leaves Income and Loans out of every figure', () => {
    const r = budgetReport(request, {
      inEffect,
      changes: [change(1, '2026-11', 1_000)],
      spending: [spent('2026-11', 1, 400), spent('2026-11', 2, 0, 90_000, 'income'), spent('2026-11', 3, 70_000, 0, 'loans')],
      thisMonth: '2027-02',
    })

    expect(r.months[0]).toMatchObject({ rows: [{ categoryId: 1, spentCents: 400 }], otherCents: 0, spentCents: 400 })
    expect(r.total.spentCents).toBe(400)
  })
})

describe('what the Report reads from D1 (ADR 0004)', () => {
  // Two years of Transactions, each with an Override, and years of history outside the dates that must not be read; a Budget change in every month for
  // five Categories. The Report is one batch of three statements and reads each Transaction in the months three times (its place in the date index, the
  // row and its Override's Category), plus the Categories and the Budget changes.
  const IN_RANGE = 2_000
  const CHANGES = 5 * 24

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO accounts (id, account_number, name) VALUES (1, '99-9999-9999999-01', 'Example everyday')").run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT 1, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(ids['Fuel'])
      .run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${IN_RANGE})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT 1, date('2025-01-01', '+' || (i % 24) || ' months', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(ids['Groceries'])
      .run()
    const months = Array.from({ length: 24 }, (_, i) => `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`)
    const spendingCategories = (await env.DB.prepare("SELECT id FROM categories WHERE kind = 'spending' AND removed_at IS NULL ORDER BY id LIMIT 5").all<{ id: number }>()).results
    expect(spendingCategories).toHaveLength(5)
    await env.DB.batch(
      spendingCategories.flatMap(({ id }) => months.map((month, i) => env.DB.prepare('INSERT INTO budgets (category_id, effective_from_month, amount_cents) VALUES (?, ?, ?)').bind(id, month, 1_000 + i))),
    )
  })

  it('takes three of the 50 queries: the Categories, the Budget changes, and the spending, which reads each Transaction in the months three times and none of the history around them', async () => {
    const categories = (await env.DB.prepare('SELECT COUNT(*) AS n FROM categories').first<{ n: number }>())!.n

    const { res, watched } = await measured('/api/reports/budget-vs-actual?from=2025-01-01&to=2026-12-31')

    expect(res.status).toBe(200)
    const body = (await res.json()) as BudgetReport
    expect(body.months).toHaveLength(24)
    expect(body.total.spentCents).toBe(IN_RANGE * 100)
    expect(watched.prepared).toHaveLength(3)
    const [categoriesRead, changesRead, spendingRead] = watched.reads as [number, number, number]
    expect(categoriesRead).toBeLessThanOrEqual(categories * 3) // each Category and a seek into its Budget changes
    expect(changesRead).toBeLessThanOrEqual(CHANGES + 5) // every Budget change, once
    expect(changesRead).toBeGreaterThanOrEqual(CHANGES)
    expect(spendingRead).toBeLessThanOrEqual(IN_RANGE * 3 + 50) // the index entry, the row and the Override's Category: not the 3,000 Transactions of 2020
    expect(spendingRead).toBeGreaterThan(IN_RANGE * 3 - 50) // the bound above means something
  })

  it('reads only the Transactions in the months asked for: a single month reads that month’s, and the Categories and Budget changes the same', async () => {
    const year = await measured('/api/reports/budget-vs-actual?from=2025-01-01&to=2025-12-31')
    const month = await measured('/api/reports/budget-vs-actual?from=2025-03-01&to=2025-03-31')

    const spent = (m: typeof year) => m.watched.reads[2]!
    expect(month.watched.reads.slice(0, 2)).toEqual(year.watched.reads.slice(0, 2))
    expect(spent(year)).toBeGreaterThan(spent(month) * 6)
    expect(spent(month)).toBeLessThanOrEqual((IN_RANGE / 24) * 3 + 50)
  })
})
