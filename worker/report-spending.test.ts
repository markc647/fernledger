import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import { buildSpending, rollUp, type SpendingRow } from './spending'
import { readSpendingByCategory, type SpendingByCategory } from './spending-by-category'

// Seam 1: the spending-by-Category Report's data (GET /api/reports/spending), through the Worker's exported handler as the local-development
// Admin or a read-only Member (the dev identity cookie is honoured on localhost only). The Report works out nothing itself: it is
// `readSpendingByCategory`'s answer (spending-by-category.ts, which has its own tests), the one the Dashboard's chart gives. So the tests here are about
// what a Report asks of it (the Account, the dates, the Account that does not exist) and that the Report and the chart agree, row for row and in total,
// and with `buildSpending` and `rollUp` run directly and with Budget vs actual. All the data is made up (bank 99).
const origin = 'http://localhost:5173'
type Who = 'admin' | 'member'

async function call(path: string, who: Who | null = 'member') {
  // Without a sign-in the request comes from a host that is not localhost, where the dev identity is never honoured.
  return exports.default.fetch(new Request(`${who ? origin : 'https://app.test'}${path}`, { headers: who ? { Cookie: `fernledger_dev_as=${who}` } : {} }))
}

let accountA = 0
let accountB = 0
const ids: Record<string, number> = {}

type Extra = { override?: string; rule?: string; ruleTransfer?: boolean }
/** Adds a made-up Transaction and returns its ID. `override` and `rule` name a Category. */
async function add(account: number, date: string, amountCents: number, extra: Extra = {}) {
  const { meta } = await env.DB.prepare(
    'INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category, rule_transfer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(account, date, amountCents, 'EXAMPLE SHOP', 'import', extra.override ? ids[extra.override]! : null, extra.rule ? ids[extra.rule]! : null, extra.ruleTransfer ? 1 : null)
    .run()
  return meta.last_row_id
}

/** Two Transactions that are each other's matching Transaction: a paired Transfer from Account A into Account B. */
async function pair(date: string, amountCents: number) {
  const out = await add(accountA, date, -amountCents)
  const into = await add(accountB, date, amountCents)
  await env.DB.batch([env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(into, out), env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(out, into)])
  return { out, into }
}

const query = (over: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries({ from: '2026-10-01', to: '2026-10-31', ...over })) if (value !== undefined) params.set(name, value)
  return params.toString()
}
async function report(over: Record<string, string | undefined> = {}, who: Who = 'member'): Promise<SpendingByCategory> {
  const res = await call(`/api/reports/spending?${query(over)}`, who)
  expect(res.status, JSON.stringify(over)).toBe(200)
  return res.json()
}
/** The Report's Categories as `[name, cents]`, in the order it gives them, Uncategorised where its amount puts it. */
const lines = (r: SpendingByCategory) => r.categories.map((c) => [c.name, c.cents])

beforeEach(async () => {
  await env.DB.batch(['budgets', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
  const [a, b] = await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example savings') RETURNING id"),
  ])
  accountA = (a!.results[0] as { id: number }).id
  accountB = (b!.results[0] as { id: number }).id
  for (const name of ['Groceries', 'Fuel', 'Eating out', 'Tax', 'Wages and salary', 'Loans']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

describe('what the Report totals', () => {
  it('adds each Spending Category over the dates, months together, the most spent first, with the total', async () => {
    await add(accountA, '2026-09-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-02', -2550, { override: 'Groceries' })
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-09-30', -30000, { override: 'Tax' })
    await add(accountB, '2026-11-10', -1500, { override: 'Eating out' })

    const r = await report({ from: '2026-09-01', to: '2026-11-30' })

    expect(lines(r)).toEqual([['Tax', 30000], ['Fuel', 9000], ['Groceries', 6550], ['Eating out', 1500]])
    expect(r.totalCents).toBe(47_050)
    expect(r).toMatchObject({ from: '2026-09-01', to: '2026-11-30' })
    expect(r).not.toHaveProperty('accountId') // every Account
  })

  it('takes money back, such as a refund, off what a Category spent, and goes below zero when more came back than went out', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', 1000, { override: 'Groceries' }) // a refund
    await add(accountA, '2026-10-05', 2500, { override: 'Fuel' }) // only money back

    const r = await report()

    expect(lines(r)).toEqual([['Groceries', 3000], ['Fuel', -2500]])
    expect(r.totalCents).toBe(500)
  })

  it('puts the Categories that spent the same in order of name, ignoring capitals', async () => {
    await add(accountA, '2026-10-02', -1000, { override: 'Tax' })
    await add(accountA, '2026-10-03', -1000, { override: 'Eating out' })
    await add(accountA, '2026-10-04', -1000, { override: 'Groceries' })
    await env.DB.prepare("UPDATE categories SET name = 'groceries' WHERE name = 'Groceries'").run()
    try {
      // A lowercase name sorts between the others, where a comparison of capitals first would put it last.
      expect(lines(await report())).toEqual([['Eating out', 1000], ['groceries', 1000], ['Tax', 1000]])
    } finally {
      await env.DB.prepare("UPDATE categories SET name = 'Groceries' WHERE name = 'groceries'").run()
    }
  })

  it('shows Uncategorised on its own, as Spending, with money in that has no Category yet taken off, and where its amount puts it', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-04', -700)
    await add(accountA, '2026-10-06', 300) // a payment in nobody has given a Category: it counts against Spending (ADR 0012)

    const r = await report()

    expect(r.categories).toEqual([{ categoryId: ids['Groceries'], name: 'Groceries', cents: 4000 }, { categoryId: null, name: 'Uncategorised', cents: 400 }])
    expect(r.totalCents).toBe(4400)

    await add(accountA, '2026-10-07', -9000) // now Uncategorised spent the most, and is first: it is not always last
    expect(lines(await report())).toEqual([['Uncategorised', 9400], ['Groceries', 4000]])
  })

  it('has Uncategorised as the whole of a Report that has nothing else, and counts what is in a removed Category as Uncategorised', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-03', -200)
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()

    const r = await report()

    expect(r.categories).toEqual([{ categoryId: null, name: 'Uncategorised', cents: 300 }])
    expect(r.totalCents).toBe(300)
  })

  it('names the Category a Rule gave and an Override over it', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { rule: 'Groceries' })

    expect(lines(await report())).toEqual([['Groceries', 200], ['Fuel', 100]])
  })

  it('is empty, with a zero total, for dates with no Transactions', async () => {
    await add(accountA, '2026-09-30', -4000, { override: 'Groceries' })

    expect(await report()).toEqual({ from: '2026-10-01', to: '2026-10-31', categories: [], totalCents: 0 })
  })

  it('includes both ends of the dates and nothing outside them, and a single day is a range', async () => {
    await add(accountA, '2026-09-30', -1, { override: 'Fuel' })
    await add(accountA, '2026-10-01', -10, { override: 'Fuel' })
    await add(accountA, '2026-10-31', -100, { override: 'Fuel' })
    await add(accountA, '2026-11-01', -1000, { override: 'Fuel' })

    expect(lines(await report())).toEqual([['Fuel', 110]])
    expect(lines(await report({ from: '2026-10-31', to: '2026-10-31' }))).toEqual([['Fuel', 100]])
  })

  it('spans the end of a year, and reads each date as the NZ date it is', async () => {
    await add(accountA, '2026-12-31', -100, { override: 'Fuel' })
    await add(accountA, '2027-01-01', -200, { override: 'Fuel' })
    await add(accountA, '2027-01-02', -400, { override: 'Fuel' })

    expect(lines(await report({ from: '2026-12-31', to: '2027-01-01' }))).toEqual([['Fuel', 300]])
  })
})

describe('what is not Spending', () => {
  it('leaves out both halves of a paired Transfer, and a Transaction a Rule marks as a Transfer', async () => {
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-06', -7000, { ruleTransfer: true })
    await add(accountA, '2026-10-07', -300, { override: 'Fuel' })

    const r = await report()

    expect(lines(r)).toEqual([['Fuel', 300]]) // no Uncategorised row: the Transfers are all there is that has no Category
    expect(r.totalCents).toBe(300)
  })

  it('leaves out a Transfer even when a Rule would have given it a Category', async () => {
    const { out } = await pair('2026-10-07', 1200)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids['Groceries'], out).run()

    expect((await report()).totalCents).toBe(0)
  })

  it('counts the half of a Transfer the Admin gave a Category under that Category, and still leaves out the other half', async () => {
    const { out } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Fuel'], out).run()

    expect(lines(await report())).toEqual([['Fuel', 5000]])
  })

  it('counts both halves of a pair the Admin says is Not a Transfer under their own Categories, Uncategorised when they have none', async () => {
    const { out, into } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Groceries'], out).run()
    expect((await report()).totalCents).toBe(5000) // only the half with a Category, while the pair stands

    const marked = await exports.default.fetch(
      new Request(`${origin}/api/transactions/${into}/not-transfer`, { method: 'POST', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
    )
    expect(marked.status).toBe(200)

    const r = await report()
    expect(lines(r)).toEqual([['Groceries', 5000], ['Uncategorised', -5000]]) // the money in is Uncategorised, which counts against Spending
    expect(r.totalCents).toBe(0)
  })

  it('leaves out an Income Category and a Loans Category, and the Transfer of a loan between tracked Accounts that has a Loans Category on both halves', async () => {
    await add(accountA, '2026-10-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-03', -50_000, { override: 'Loans' })
    await add(accountA, '2026-10-04', 10_000, { rule: 'Loans' })
    const { out, into } = await pair('2026-10-05', 20_000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id IN (?, ?)').bind(ids['Loans'], out, into).run()
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    const r = await report()

    expect(lines(r)).toEqual([['Fuel', 300]])
    expect(r.totalCents).toBe(300)
  })

  it('follows a change of a Category\'s kind at once, for every date, since the kind is not stored on the Transaction', async () => {
    await add(accountA, '2026-10-10', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-11', -200, { override: 'Groceries' })
    await env.DB.prepare("UPDATE categories SET kind = 'income' WHERE name = 'Fuel'").run()
    try {
      expect(lines(await report())).toEqual([['Groceries', 200]])
      await env.DB.prepare("UPDATE categories SET kind = 'loans' WHERE name = 'Fuel'").run()
      expect(lines(await report())).toEqual([['Groceries', 200]])
    } finally {
      await env.DB.prepare("UPDATE categories SET kind = 'spending' WHERE name = 'Fuel'").run()
    }
    expect(lines(await report())).toEqual([['Groceries', 200], ['Fuel', 100]])
  })

  // A Pending Transaction is stored apart from `transactions` (spec #1), and Sync, which stores them, is not built yet, so there is nothing to
  // test with. The Sync ticket adds the table and must turn this into a test with a Pending Transaction in the same dates and Category
  // (spending.test.ts has the same one for the totals this Report reads).
  it.todo('leaves out a Pending Transaction')
})

describe('one Account or all of them', () => {
  beforeEach(async () => {
    await add(accountA, '2026-10-02', -1000, { override: 'Groceries' })
    await add(accountB, '2026-10-03', -250, { override: 'Groceries' })
    await add(accountB, '2026-10-04', 75, { override: 'Eating out' })
    await add(accountB, '2026-10-05', -40)
    await pair('2026-10-06', 5000)
  })

  it('totals every Account when none is named', async () => {
    const r = await report()
    expect(lines(r)).toEqual([['Groceries', 1250], ['Uncategorised', 40], ['Eating out', -75]])
    expect(r.totalCents).toBe(1215)
    expect(r).not.toHaveProperty('accountId')
  })

  it('totals only the Account named, and says which', async () => {
    const savings = await report({ accountId: String(accountB) })
    expect(lines(savings)).toEqual([['Groceries', 250], ['Uncategorised', 40], ['Eating out', -75]])
    expect(savings.totalCents).toBe(215)
    expect(savings.accountId).toBe(accountB)

    const everyday = await report({ accountId: String(accountA) })
    expect(lines(everyday)).toEqual([['Groceries', 1000]]) // the Transfer out of this Account is not spending, so there is no Uncategorised row
  })

  it('is a 404 for an Account that does not exist, not an empty Report', async () => {
    const res = await call(`/api/reports/spending?${query({ accountId: String(accountB + 1000) })}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('the same figures as everywhere else that totals spending (ADR 0012)', () => {
  /** A few months of everything that is and is not spending, across two Accounts. */
  async function history() {
    await add(accountA, '2026-09-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-02', -2550, { override: 'Groceries' })
    await add(accountA, '2026-10-20', 1000, { override: 'Groceries' })
    await add(accountB, '2026-10-05', -2000, { rule: 'Groceries' })
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-11-04', -3000, { override: 'Fuel' })
    await add(accountB, '2026-11-10', -1500, { override: 'Eating out' })
    await add(accountA, '2026-09-30', -30000, { override: 'Tax' })
    await add(accountA, '2026-10-04', -700)
    await add(accountA, '2026-10-06', 300)
    await add(accountA, '2026-10-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-03', -50_000, { override: 'Loans' })
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-08', -7000, { ruleTransfer: true })
  }

  /** What `rollUp` makes of `buildSpending`, run here directly against D1 (no Report and no chart in between): Spending Categories and the total. */
  async function direct(range: { from: string; to: string; accountId?: number }) {
    const { sql, binds } = buildSpending(range)
    const rows = (await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()).results
    const { byCategory, totals } = rollUp(rows)
    return { byCategory: byCategory.filter((total) => total.kind === 'spending'), totalCents: totals.spendingCents }
  }

  const ranges = [
    ['all three months', { from: '2026-09-01', to: '2026-11-30' }],
    ['one month', { from: '2026-10-01', to: '2026-10-31' }],
    ['part of a month', { from: '2026-10-02', to: '2026-10-20' }],
    ['one day', { from: '2026-10-05', to: '2026-10-05' }],
    ['dates with nothing in them', { from: '2025-01-01', to: '2025-12-31' }],
  ] as const

  it.each(ranges)("gives, for %s, what rollUp's byCategory and totals give for buildSpending's rows", async (_what, range) => {
    await history()
    const expected = await direct(range)

    const r = await report(range)

    expect(Object.fromEntries(r.categories.map((c) => [c.categoryId, c.cents]))).toEqual(Object.fromEntries(expected.byCategory.map((total) => [total.categoryId, total.cents])))
    expect(r.totalCents).toBe(expected.totalCents)
  })

  it.each([
    ['one Account', 'a'],
    ['the other Account', 'b'],
  ] as const)("gives, for %s, what rollUp's byCategory and totals give for buildSpending's rows", async (_what, which) => {
    await history()
    const accountId = which === 'a' ? accountA : accountB
    const range = { from: '2026-09-01', to: '2026-11-30' }
    const expected = await direct({ ...range, accountId })

    const r = await report({ ...range, accountId: String(accountId) })

    expect(Object.fromEntries(r.categories.map((c) => [c.categoryId, c.cents]))).toEqual(Object.fromEntries(expected.byCategory.map((total) => [total.categoryId, total.cents])))
    expect(r.totalCents).toBe(expected.totalCents)
  })

  // The Dashboard's chart and a Report of spending by Category are one function's answer (spending-by-category.ts), so the same dates give the same rows, in the
  // same order, with the same total. This is the test that holds them to it: a Report that named, ordered or totalled its own would fail it.
  it.each(ranges)('gives, for %s, the very rows and total /api/charts/spending gives for the same dates', async (_what, range) => {
    await history()

    const r = await report(range)
    const chart = (await (await call(`/api/charts/spending?from=${range.from}&to=${range.to}`)).json()) as SpendingByCategory

    expect(r.categories).toEqual(chart.categories)
    expect(r.totalCents).toBe(chart.totalCents)
    expect(r).toEqual(chart)
    if (range.from === '2026-09-01') expect(r.categories.length).toBeGreaterThan(3) // the history does have something to compare
  })

  it('gives, for one Account, what readSpendingByCategory gives for it (the chart is for every Account)', async () => {
    await history()
    const range = { from: '2026-09-01', to: '2026-11-30', accountId: accountB }

    expect(await report({ from: range.from, to: range.to, accountId: String(accountB) })).toEqual(await readSpendingByCategory(env.DB, range))
  })

  it('gives for a month what Budget vs actual spent: each Category with a Budget, the rest together, and Uncategorised', async () => {
    await history()
    for (const name of ['Groceries', 'Tax']) {
      const set = await exports.default.fetch(
        new Request(`${origin}/api/budgets/${ids[name]}`, { method: 'PUT', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ effectiveFrom: '2026-10', amountCents: 10_000 }) }),
      )
      expect(set.status).toBe(200)
    }
    const vsActual = (await (await call('/api/budgets/vs-actual?month=2026-10')).json()) as { rows: { categoryId: number; spentCents: number }[]; otherCents: number; uncategorisedCents: number }

    const r = await report({ from: '2026-10-01', to: '2026-10-31' })

    const budgeted = new Map(vsActual.rows.map((row) => [row.categoryId, row.spentCents]))
    expect([...budgeted.keys()].sort()).toEqual([ids['Groceries']!, ids['Tax']!].sort())
    for (const [categoryId, spentCents] of budgeted) expect(r.categories.find((c) => c.categoryId === categoryId)?.cents ?? 0, `Category ${categoryId}`).toBe(spentCents)
    expect(r.categories.filter((c) => c.categoryId !== null && !budgeted.has(c.categoryId)).reduce((sum, c) => sum + c.cents, 0)).toBe(vsActual.otherCents)
    expect(r.categories.find((c) => c.categoryId === null)?.cents ?? 0).toBe(vsActual.uncategorisedCents)
    expect(r.totalCents).toBe([...budgeted.values()].reduce((sum, c) => sum + c, 0) + vsActual.otherCents + vsActual.uncategorisedCents)
  })
})

describe('who can read it, and what a request refuses', () => {
  it('gives every Member the same Report as the Admin', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    expect(await report({}, 'admin')).toEqual(await report({}, 'member'))
    expect(lines(await report({}, 'member'))).toEqual([['Groceries', 4000]])
  })

  it('is closed to anyone who is not signed in', async () => {
    expect((await call(`/api/reports/spending?${query()}`, null)).status).toBe(401)
  })

  // The refusal names the field and never a value: values can be Transaction data.
  it.each([
    ['no From date', { from: undefined }, 'from'],
    ['no To date', { to: undefined }, 'to'],
    ['a From date that is not a day', { from: '2026-02-30' }, 'from'],
    ['a From date that is not a date', { from: 'soon' }, 'from'],
    ['a To date outside the years accepted', { to: '2101-01-01' }, 'to'],
    ['a From date before the years accepted', { from: '1999-12-31' }, 'from'],
    ['a range that ends before it starts', { from: '2026-11-01', to: '2026-10-01' }, 'to'],
    ['an Account that is not a number', { accountId: 'x' }, 'accountId'],
    ['an Account with a sign', { accountId: '-1' }, 'accountId'],
    ['an Account of zero', { accountId: '0' }, 'accountId'],
    ['an Account with too many digits', { accountId: '1234567890123456' }, 'accountId'],
    ['an Account that is empty', { accountId: '' }, 'accountId'],
  ])('refuses %s', async (_what, over, field) => {
    const res = await call(`/api/reports/spending?${query(over)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
  })

  it('takes an Account of fifteen digits, the most an ID has, and says there is no such Account', async () => {
    const res = await call(`/api/reports/spending?${query({ accountId: '999999999999999' })}`)
    expect(res.status).toBe(404)
  })
})

describe('what a request costs (ADR 0004)', () => {
  /** D1 that counts the statements prepared on it and the rows its queries read, to see what one request asks of the free plan. */
  function metered() {
    const usage = { queries: 0, rowsRead: 0 }
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
          if (property === 'all') {
            return async () => {
              const result = await target.all()
              usage.rowsRead += (result.meta as { rows_read: number }).rows_read
              return result
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            usage.queries += 1
            return wrap(target.prepare(sql))
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { db, usage }
  }
  /** The Worker's handler with `db` standing in for D1, called directly because the test changes the Worker's env (CODING_STANDARDS.md: Tests). */
  async function requestWith(db: D1Database, over: Record<string, string | undefined> = {}) {
    const ctx = createExecutionContext()
    const res = await worker.fetch!(new Request(`${origin}/api/reports/spending?${query(over)}`, { headers: { Cookie: 'fernledger_dev_as=member' } }) as never, { ...env, DB: db }, ctx)
    await waitOnExecutionContext(ctx)
    return res
  }

  const SLACK = 20 // the grouping of the months

  beforeEach(async () => {
    // 3,000 Transactions of history from 2020, none in the dates below: they must cost nothing.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Fuel'])
      .run()
    // A year of 480 Transactions, 40 a month, each with an Override and a Rule that both name a Category: the dearest kind.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 479)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT ?, date('2026-01-01', '+' || (i / 40) || ' months', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ?, ? FROM seq`,
    )
      .bind(accountA, ids['Groceries'], ids['Fuel'])
      .run()
  })

  it('is one D1 query for all Accounts, and two for one (the check that it exists), however many Transactions', async () => {
    const all = metered()
    const res = await requestWith(all.db, { from: '2026-01-01', to: '2026-12-31' })
    expect(res.status).toBe(200)
    expect(all.usage.queries).toBe(1)

    const one = metered()
    expect((await requestWith(one.db, { from: '2026-01-01', to: '2026-12-31', accountId: String(accountA) })).status).toBe(200)
    expect(one.usage.queries).toBe(2)
  })

  it('reads the Transactions of the dates asked for, four rows each, and not the history around them', async () => {
    const { db, usage } = metered()

    const res = await requestWith(db, { from: '2026-01-01', to: '2026-12-31' })

    const r = (await res.json()) as SpendingByCategory
    expect(lines(r)).toEqual([['Groceries', 48_000]])
    // The date index entry, the row, the Override's Category and the Rule's Category for each Transaction.
    expect(usage.rowsRead).toBeLessThanOrEqual(480 * 4 + SLACK)
    expect(usage.rowsRead).toBeGreaterThan(480 * 3) // the Rule's Category is read too, so the allowance above is not slack for a cheaper plan
  })

  it('reads nothing of the Transactions outside the dates: a month costs a month', async () => {
    const { db, usage } = metered()

    await requestWith(db, { from: '2026-03-01', to: '2026-03-31' })

    expect(usage.rowsRead).toBeLessThanOrEqual(40 * 4 + SLACK)
  })

  it('reads none of the figures for an Account that does not exist: it asks, finds none, and stops', async () => {
    const { db, usage } = metered()

    const res = await requestWith(db, { from: '2026-01-01', to: '2026-12-31', accountId: String(accountB + 1000) })

    expect(res.status).toBe(404)
    expect(usage.queries).toBe(1)
    expect(usage.rowsRead).toBe(0) // the check is a `first()`, which D1 does not report rows for, and nothing else was read
  })
})
