import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildMonthlySpending, buildSpending, isLoan, rollUp, rollUpMonthly, type MonthlyRow, type SpendingRow } from './spending'
import { effectiveCategory } from './effective-category'

// Spending and Income (spending.ts, ADR 0012), tested directly against D1. How Budgets use them, through the real request
// path, is in budgets.test.ts. All the data is made up (bank 99).

let accountA = 0
let accountB = 0
const ids: Record<string, number> = {}

type Extra = { override?: string; rule?: string; ruleTransfer?: boolean }
/** Adds a Transaction and returns its ID. `override` and `rule` name a Category. */
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
  return { out, into }
}

async function spending(from: string, to: string, accountId?: number): Promise<SpendingRow[]> {
  const { sql, binds } = buildSpending({ from, to, accountId })
  return (await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()).results
}
/** A whole month, for all Accounts. */
const inMonth = (month: string) => spending(`${month}-01`, `${month}-31`)

/** What a month shows for a Category: `[out, in]` in cents, or undefined when it has no spending. */
const of = (rows: SpendingRow[], month: string, category: string | null) => {
  const row = rows.find((r) => r.month === month && r.categoryId === (category === null ? null : ids[category]))
  return row && [row.outCents, row.inCents]
}

beforeEach(async () => {
  await env.DB.batch(['budgets', 'transactions', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
  const [a, b] = await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example savings') RETURNING id"),
  ])
  accountA = (a!.results[0] as { id: number }).id
  accountB = (b!.results[0] as { id: number }).id
  for (const name of ['Groceries', 'Fuel', 'Eating out', 'Wages and salary', 'Loans']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

describe('money out and in by month and Category', () => {
  it('totals money out and money in apart, by NZ month and the Category the Transaction is in', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', -1550, { override: 'Groceries' })
    await add(accountA, '2026-10-21', 1000, { override: 'Groceries' }) // a refund
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-09-30', -777, { override: 'Groceries' })

    const rows = await spending('2026-09-01', '2026-10-31')

    expect(of(rows, '2026-10', 'Groceries')).toEqual([5550, 1000])
    expect(of(rows, '2026-10', 'Fuel')).toEqual([9000, 0])
    expect(of(rows, '2026-09', 'Groceries')).toEqual([777, 0])
    expect(rows).toHaveLength(3)
  })

  it('takes the Category from the Override, then the Rule, and leaves the rest Uncategorised', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { rule: 'Groceries' })
    await add(accountA, '2026-10-04', -400)

    const rows = await inMonth('2026-10')

    expect(of(rows, '2026-10', 'Fuel')).toEqual([100, 0])
    expect(of(rows, '2026-10', 'Groceries')).toEqual([200, 0])
    expect(of(rows, '2026-10', null)).toEqual([400, 0])
  })

  it('counts a Transaction in a removed Category under the next one that names a Category in use, or as Uncategorised', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { override: 'Fuel' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()

    const rows = await inMonth('2026-10')

    expect(of(rows, '2026-10', 'Groceries')).toEqual([100, 0])
    expect(of(rows, '2026-10', null)).toEqual([200, 0])
    expect(of(rows, '2026-10', 'Fuel')).toBeUndefined()
  })

  it('names each row after the Category it is shown under: the Override\'s over the Rule\'s, none for Uncategorised, and the next one\'s when a Category is removed', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { rule: 'Groceries' })
    await add(accountA, '2026-10-04', -400)
    await add(accountA, '2026-10-05', -800, { override: 'Eating out', rule: 'Groceries' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Eating out'").run()

    const names = (await inMonth('2026-10')).map((r) => [r.categoryName, r.outCents])

    expect(names).toEqual(expect.arrayContaining([['Fuel', 100], ['Groceries', 1000], [null, 400]])) // the Override gone with its Category, the Rule's counts
    expect(names).toHaveLength(3)
  })

  it('reads a Transaction date as the NZ date it is, so the last and first days of a month fall where they should', async () => {
    await add(accountA, '2026-09-30', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-01', -200, { override: 'Fuel' })
    await add(accountA, '2026-10-31', -400, { override: 'Fuel' })
    await add(accountA, '2026-11-01', -800, { override: 'Fuel' })

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], categoryName: 'Fuel', kind: 'spending', outCents: 600, inCents: 0 }])
  })

  it('spans the end of a year', async () => {
    await add(accountA, '2026-12-31', -100, { override: 'Fuel' })
    await add(accountA, '2027-01-01', -200, { override: 'Fuel' })

    expect((await spending('2026-12-01', '2027-01-31')).map((r) => [r.month, r.outCents])).toEqual([['2026-12', 100], ['2027-01', 200]])
  })
})

describe('a range of dates', () => {
  it('takes whole days from the first date to the last, both included, and groups what it holds by the month each day is in', async () => {
    for (const date of ['2026-10-09', '2026-10-10', '2026-10-31', '2026-11-01', '2026-11-05', '2026-11-06']) await add(accountA, date, -100, { override: 'Fuel' })

    const rows = await spending('2026-10-10', '2026-11-05')

    expect(rows.map((r) => [r.month, r.outCents])).toEqual([['2026-10', 200], ['2026-11', 200]])
  })

  it('can be one day', async () => {
    await add(accountA, '2026-10-09', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-10', -300, { override: 'Fuel' })
    await add(accountA, '2026-10-11', -500, { override: 'Fuel' })

    expect((await spending('2026-10-10', '2026-10-10')).map((r) => r.outCents)).toEqual([300])
  })

  it('is empty when the first date is after the last', async () => {
    await add(accountA, '2026-10-10', -300, { override: 'Fuel' })

    expect(await spending('2026-10-11', '2026-10-09')).toEqual([])
  })
})

describe('one Account', () => {
  it('counts only that Account\'s Transactions, and all of them when no Account is named', async () => {
    await add(accountA, '2026-10-02', -1000, { override: 'Groceries' })
    await add(accountB, '2026-10-03', -250, { override: 'Groceries' })
    await add(accountB, '2026-10-04', 75, { override: 'Eating out' })

    expect(of(await spending('2026-10-01', '2026-10-31', accountA), '2026-10', 'Groceries')).toEqual([1000, 0])
    const savings = await spending('2026-10-01', '2026-10-31', accountB)
    expect(of(savings, '2026-10', 'Groceries')).toEqual([250, 0])
    expect(of(savings, '2026-10', 'Eating out')).toEqual([0, 75])
    expect(of(await spending('2026-10-01', '2026-10-31'), '2026-10', 'Groceries')).toEqual([1250, 0])
  })

  it('leaves out a Transfer of that Account, and has nothing for an Account with no Transactions', async () => {
    await pair('2026-10-05', 5000)

    expect(await spending('2026-10-01', '2026-10-31', accountA)).toEqual([])
    expect(await spending('2026-10-01', '2026-10-31', accountB + 1000)).toEqual([])
  })
})

describe('what is not spending', () => {
  it('leaves out both halves of a paired Transfer', async () => {
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], categoryName: 'Fuel', kind: 'spending', outCents: 300, inCents: 0 }])
  })

  it('leaves out a Transaction a Rule marks as a Transfer when nothing paired it', async () => {
    await add(accountA, '2026-10-05', -7000, { ruleTransfer: true })
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], categoryName: 'Fuel', kind: 'spending', outCents: 300, inCents: 0 }])
  })

  it('leaves out a Transfer even when a Rule would have given it a Category', async () => {
    await add(accountA, '2026-10-05', -7000, { ruleTransfer: true, rule: 'Groceries' })
    const { out } = await pair('2026-10-07', 1200)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids['Groceries'], out).run()

    expect(await inMonth('2026-10')).toEqual([])
  })

  it('counts a half of a Transfer as spending in the Category the Admin chose for it, and still leaves out the other half', async () => {
    const { out } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Fuel'], out).run()

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], categoryName: 'Fuel', kind: 'spending', outCents: 5000, inCents: 0 }])
  })

  it('counts money sent to an account that is not tracked, which has nothing to pair with', async () => {
    await add(accountA, '2026-10-05', -5000, { override: 'Eating out' })

    expect(of(await inMonth('2026-10'), '2026-10', 'Eating out')).toEqual([5000, 0])
  })

  // A Pending Transaction is stored apart from `transactions` (spec #1), and Sync, which stores them, is not built yet, so there is nothing to
  // test with. The Sync ticket adds the table and must turn this into a test with a Pending Transaction in the same month and Category.
  it.todo('leaves out a Pending Transaction')
})

describe('the kind of each Category', () => {
  it("gives each row the kind of its effective Category, and Uncategorised the kind Spending", async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Groceries' })
    await add(accountA, '2026-10-03', 300_000, { rule: 'Wages and salary' })
    await add(accountA, '2026-10-04', -50_000, { override: 'Loans' })
    await add(accountA, '2026-10-05', -700)

    const rows = await inMonth('2026-10')

    // Oldest month first, then Uncategorised, then by Category ID.
    expect(rows.map((r) => [r.categoryId, r.kind])).toEqual([[null, 'spending'], [ids['Groceries'], 'spending'], [ids['Wages and salary'], 'income'], [ids['Loans'], 'loans']])
  })

  it('follows a change of kind at once, for every month, since the kind is not stored on the Transaction', async () => {
    await add(accountA, '2026-09-10', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-10', -100, { override: 'Fuel' })
    await env.DB.prepare("UPDATE categories SET kind = 'income' WHERE name = 'Fuel'").run()

    try {
      expect((await spending('2026-09-01', '2026-10-31')).map((r) => r.kind)).toEqual(['income', 'income'])
    } finally {
      await env.DB.prepare("UPDATE categories SET kind = 'spending' WHERE name = 'Fuel'").run()
    }
  })

  it('has the starter income Categories as Income, a starter Loans Category as Loans, and the rest as Spending', async () => {
    const kinds = (await env.DB.prepare('SELECT name, kind FROM categories WHERE removed_at IS NULL').all<{ name: string; kind: string }>()).results
    const named = (kind: string) => kinds.filter((c) => c.kind === kind).map((c) => c.name).sort()

    expect(named('income')).toEqual(['Interest', 'NZ Super and benefits', 'Other income', 'Wages and salary'])
    expect(named('loans')).toEqual(['Loans'])
    expect(named('spending')).toHaveLength(kinds.length - 5)
    expect(named('spending')).toEqual(expect.arrayContaining(['Groceries', 'Fuel', 'Tax', 'Bank fees']))
  })
})

describe('rollUp', () => {
  // A Category's name goes with its ID, as `buildSpending` gives it; Uncategorised has none.
  const row = (month: string, categoryId: number | null, kind: SpendingRow['kind'], outCents: number, inCents: number): SpendingRow => ({ month, categoryId, categoryName: categoryId === null ? null : `Category ${categoryId}`, kind, outCents, inCents })

  it('works out Spending as money out less money in, and Income as money in less money out', () => {
    const { categories } = rollUp([
      row('2026-10', 1, 'spending', 5550, 1000), // a refund comes off
      row('2026-10', 2, 'income', 250, 300_000), // money out of an Income Category comes off
      row('2026-10', null, 'spending', 700, 0),
    ])

    expect(categories).toEqual([
      { month: '2026-10', categoryId: 1, categoryName: 'Category 1', kind: 'spending', cents: 4550 },
      { month: '2026-10', categoryId: 2, categoryName: 'Category 2', kind: 'income', cents: 299_750 },
      { month: '2026-10', categoryId: null, categoryName: null, kind: 'spending', cents: 700 },
    ])
  })

  it('goes below zero when more came back than went out, or more went out of an Income Category than came in', () => {
    const { categories, months } = rollUp([row('2026-10', 1, 'spending', 0, 1500), row('2026-10', 2, 'income', 800, 0)])

    expect(categories.map((c) => c.cents)).toEqual([-1500, -800])
    expect(months).toEqual([{ month: '2026-10', spendingCents: -1500, incomeCents: -800 }])
  })

  it('leaves a Loans Category out of everything', () => {
    const { categories, months } = rollUp([row('2026-10', 1, 'spending', 1000, 0), row('2026-10', 3, 'loans', 50_000, 20_000), row('2026-11', 3, 'loans', 0, 5_000)])

    expect(categories).toEqual([{ month: '2026-10', categoryId: 1, categoryName: 'Category 1', kind: 'spending', cents: 1000 }])
    expect(months).toEqual([{ month: '2026-10', spendingCents: 1000, incomeCents: 0 }]) // November had only a loan, so it has no entry
  })

  it('adds up Spending and Income in each month, apart, in the order the months came', () => {
    const { months } = rollUp([
      row('2026-09', 1, 'spending', 100, 0),
      row('2026-09', 2, 'spending', 250, 50),
      row('2026-09', 4, 'income', 0, 1_000),
      row('2026-10', 1, 'spending', 7, 0),
    ])

    expect(months).toEqual([
      { month: '2026-09', spendingCents: 300, incomeCents: 1_000 },
      { month: '2026-10', spendingCents: 7, incomeCents: 0 },
    ])
  })

  it('adds each Category up over every month given, so a range is not added up by the caller; Uncategorised is null', () => {
    const { byCategory } = rollUp([
      row('2026-09', 1, 'spending', 4000, 0),
      row('2026-10', 1, 'spending', 500, 100),
      row('2026-09', null, 'spending', 7, 0),
      row('2026-10', null, 'spending', 0, 1000),
      row('2026-09', 2, 'income', 0, 300_000),
      row('2026-10', 2, 'income', 20, 300_000),
      row('2026-10', 3, 'loans', 50_000, 0),
    ])

    expect(byCategory).toEqual([
      { categoryId: 1, categoryName: 'Category 1', kind: 'spending', cents: 4400 },
      { categoryId: null, categoryName: null, kind: 'spending', cents: -993 },
      { categoryId: 2, categoryName: 'Category 2', kind: 'income', cents: 599_980 },
    ])
  })

  it('adds Spending and Income over every row given, apart, so a range\'s total is not added up by the caller; a Loans Category is not in it', () => {
    const { totals, months } = rollUp([
      row('2026-09', 1, 'spending', 4000, 0),
      row('2026-10', 1, 'spending', 500, 100),
      row('2026-10', null, 'spending', 0, 1000), // money in with no Category yet comes off Spending
      row('2026-09', 2, 'income', 0, 300_000),
      row('2026-10', 2, 'income', 20, 0),
      row('2026-10', 3, 'loans', 50_000, 0),
    ])

    expect(totals).toEqual({ spendingCents: 4000 + 400 - 1000, incomeCents: 300_000 - 20 })
    expect(totals.spendingCents).toBe(months.reduce((sum, month) => sum + month.spendingCents, 0)) // it is the months added up
    expect(totals.incomeCents).toBe(months.reduce((sum, month) => sum + month.incomeCents, 0))
  })

  it('has nothing for no rows', () => {
    expect(rollUp([])).toEqual({ categories: [], byCategory: [], months: [], totals: { spendingCents: 0, incomeCents: 0 } })
  })
})

describe('rollUpMonthly', () => {
  const row = (month: string, kind: MonthlyRow['kind'], outCents: number, inCents: number, over: Partial<MonthlyRow> = {}): MonthlyRow => ({ month, uncategorised: 0, kind, outCents, inCents, counted: 1, ...over })

  it('works out Spending as money out less money in and Income as money in less money out, for each month and in all, and leaves Loans out', () => {
    const r = rollUpMonthly([
      row('2026-09', 'spending', 4000, 500),
      row('2026-09', 'spending', 7, 0, { uncategorised: 1 }),
      row('2026-09', 'income', 20, 300_000),
      row('2026-09', 'loans', 50_000, 0),
      row('2026-10', 'spending', 0, 1500),
      row('2026-10', 'income', 800, 0),
      row('2026-11', 'loans', 0, 5_000),
    ])

    expect(r.months.map(({ month, spendingCents, incomeCents }) => [month, spendingCents, incomeCents])).toEqual([['2026-09', 3507, 299_980], ['2026-10', -1500, -800]]) // November had only a loan: no entry
    expect(r.totals).toMatchObject({ spendingCents: 2007, incomeCents: 299_180 })
    expect(rollUpMonthly([])).toEqual({ months: [], totals: { spendingCents: 0, incomeCents: 0, uncategorisedInCents: 0, counted: 0 } })
  })

  it('adds up the money in that has no Category, from the rows that say so, and how many Transactions were counted, for each month and in all', () => {
    const r = rollUpMonthly([
      row('2026-01', 'spending', 100, 40, { uncategorised: 1, counted: 3 }),
      row('2026-01', 'spending', 0, 999, { counted: 2 }), // money in to a Category is not Uncategorised
      row('2026-03', 'spending', 5, 25, { uncategorised: 1, counted: 4 }),
      row('2026-03', 'income', 0, 70, { counted: 1 }),
      row('2026-03', 'loans', 9, 9, { counted: 6 }), // a loan is not counted
    ])

    expect(r.months.map((m) => [m.month, m.uncategorisedInCents, m.counted])).toEqual([['2026-01', 40, 5], ['2026-03', 25, 5]])
    expect(r.totals).toMatchObject({ uncategorisedInCents: 65, counted: 10 })
  })

  it('counts a month that nets out to nothing, and finds a month again when its rows are apart', () => {
    const r = rollUpMonthly([row('2026-09', 'spending', 4000, 4000, { counted: 2 }), row('2026-10', 'spending', 7, 0), row('2026-09', 'income', 0, 0, { counted: 1 })])

    expect(r.months.map((m) => [m.month, m.spendingCents, m.counted])).toEqual([['2026-09', 0, 3], ['2026-10', 7, 1]])
  })
})

describe('buildMonthlySpending', () => {
  const monthly = async (range: Parameters<typeof buildMonthlySpending>[0]) => {
    const { sql, binds } = buildMonthlySpending(range)
    const result = await env.DB.prepare(sql).bind(...binds).all<MonthlyRow>()
    return { rows: result.results, reads: (result.meta as { rows_read: number }).rows_read }
  }
  const full = async (range: Parameters<typeof buildSpending>[0]) => {
    const { sql, binds } = buildSpending(range)
    const result = await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()
    return { rows: result.results, reads: (result.meta as { rows_read: number }).rows_read }
  }

  /** Everything that tells Spending, Income, Loans, Uncategorised and Transfers apart, across two Accounts and four months. */
  async function history() {
    await add(accountA, '2026-08-05', -4000, { override: 'Groceries' })
    await add(accountA, '2026-08-20', 1000, { override: 'Groceries' }) // a refund
    await add(accountB, '2026-09-05', -2000, { rule: 'Groceries' })
    await add(accountA, '2026-09-05', -9000, { override: 'Fuel', rule: 'Groceries' }) // an Override outranks a Rule
    await add(accountA, '2026-09-09', -700) // Uncategorised
    await add(accountA, '2026-09-10', 300) // money in with no Category
    await add(accountB, '2026-09-11', 450)
    await add(accountA, '2026-09-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-01', 300_000, { rule: 'Wages and salary' })
    await add(accountA, '2026-10-03', -50_000, { override: 'Loans' })
    await add(accountB, '2026-10-04', 10_000, { rule: 'Loans' })
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-08', -7000, { ruleTransfer: true })
    const { out } = await pair('2026-10-12', 1200)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Fuel'], out).run() // a half of a Transfer the Admin gave a Category
    await add(accountA, '2026-11-02', -200, { override: 'Eating out' })
    await add(accountA, '2026-11-03', -300, { override: 'Eating out' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Eating out'").run() // so it is Uncategorised
  }

  const ranges = [
    ['all four months', { from: '2026-08-01', to: '2026-11-30' }],
    ['one month', { from: '2026-09-01', to: '2026-09-30' }],
    ['part of two months', { from: '2026-09-06', to: '2026-10-09' }],
    ['one day', { from: '2026-09-05', to: '2026-09-05' }],
    ['dates with nothing in them', { from: '2025-01-01', to: '2025-12-31' }],
  ] as const

  // The two statements are built from one (spending.ts's `spendingStatement`), and this is what holds the second to the first on the data: the same Spending and Income for
  // every month and in all, and the money in with no Category, which `buildSpending` has as the row with no Category ID.
  it.each(ranges)("gives, for %s, the months and totals rollUp gives for buildSpending's rows, and the money in that has no Category", async (_what, range) => {
    await history()

    const expected = rollUp((await full(range)).rows)
    const none = (await full(range)).rows.filter((r) => r.categoryId === null)
    const got = rollUpMonthly((await monthly(range)).rows)

    expect(got.months.map(({ month, spendingCents, incomeCents }) => ({ month, spendingCents, incomeCents }))).toEqual(expected.months)
    expect(got.totals).toMatchObject(expected.totals)
    expect(got.totals.uncategorisedInCents).toBe(none.reduce((sum, r) => sum + r.inCents, 0))
    for (const m of got.months) expect(m.uncategorisedInCents, m.month).toBe(none.filter((r) => r.month === m.month).reduce((sum, r) => sum + r.inCents, 0))
    if (range.from === '2026-08-01') expect(got.totals.uncategorisedInCents).toBeGreaterThan(0) // the history does have some
  })

  it.each([['one Account', 'a'], ['the other Account', 'b']] as const)('gives, for %s, what buildSpending gives for it', async (_what, which) => {
    await history()
    const range = { from: '2026-08-01', to: '2026-11-30', accountId: which === 'a' ? accountA : accountB }

    const expected = rollUp((await full(range)).rows)
    const got = rollUpMonthly((await monthly(range)).rows)

    expect(got.months.map(({ month, spendingCents, incomeCents }) => ({ month, spendingCents, incomeCents }))).toEqual(expected.months)
    expect(got.totals).toMatchObject(expected.totals)
  })

  it('counts the Transactions it adds up, and none of a Transfer, and a loan only in the Loans rows that rollUpMonthly leaves out', async () => {
    await history()

    const { rows } = await monthly({ from: '2026-08-01', to: '2026-11-30' })

    // Counted: August 2, September 6 (the Override's and the Rule's, the Uncategorised two, the other money in, the wages), October 2 (wages, and the half of a Transfer given a Category),
    // November 2. Not counted: the Transfers, and the loans, which are in the 'loans' rows.
    expect(rollUpMonthly(rows).months.map((m) => [m.month, m.counted])).toEqual([['2026-08', 2], ['2026-09', 6], ['2026-10', 2], ['2026-11', 2]])
    expect(rows.filter((r) => r.kind === 'loans').reduce((sum, r) => sum + r.counted, 0)).toBe(2)
  })

  it('hands back at most four rows a month, however many Categories there are, where buildSpending hands back a row for each Category', async () => {
    for (let i = 0; i < 25; i++) {
      const { meta } = await env.DB.prepare("INSERT INTO categories (name, kind) VALUES (?, 'spending')").bind(`Extra category ${i}`).run()
      await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category) VALUES (?, ?, ?, ?, ?, ?)').bind(accountA, '2026-10-02', -100, 'EXAMPLE SHOP', 'import', meta.last_row_id).run()
    }
    await add(accountA, '2026-10-03', 5000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-04', -700)

    const range = { from: '2026-10-01', to: '2026-10-31' }
    try {
      expect((await full(range)).rows).toHaveLength(27)
      expect((await monthly(range)).rows).toHaveLength(3) // Spending with a Category, Spending with none, and Income
    } finally {
      await env.DB.prepare('DELETE FROM transactions').run()
      await env.DB.prepare("DELETE FROM categories WHERE name LIKE 'Extra category %'").run()
    }
  })

  it('reads what buildSpending reads, a month of Transactions and not the history around it', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Fuel'])
      .run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 400)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT ?, date('2026-10-01', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ?, ? FROM seq`,
    )
      .bind(accountA, ids['Groceries'], ids['Fuel'])
      .run()
    const range = { from: '2026-10-01', to: '2026-10-31' }

    const a = await full(range)
    const b = await monthly(range)

    expect(b.reads).toBeLessThanOrEqual(a.reads) // the same rows of the same Transactions: it never reads more (D1 reported 1,600 for this against 1,601)
    expect(b.reads).toBeGreaterThan(400 * 3) // the index entry, the row and a Category for each of the 400, so it did read them
    expect(b.rows).toHaveLength(1)
    expect(b.rows[0]).toMatchObject({ month: '2026-10', kind: 'spending', uncategorised: 0, outCents: 40_000, inCents: 0, counted: 400 })
  })
})

describe('isLoan', () => {
  const loans = async () => {
    const category = effectiveCategory()
    const sql = `SELECT t.id FROM transactions t ${category.joins} WHERE ${isLoan(category)} ORDER BY t.id`
    return (await env.DB.prepare(sql).all<{ id: number }>()).results.map((r) => r.id)
  }

  it('picks out the Transactions in a Loans Category, whether money went out or came in, and no others', async () => {
    const lent = await add(accountA, '2026-10-02', -50_000, { override: 'Loans' })
    const repaid = await add(accountA, '2026-10-20', 10_000, { rule: 'Loans' })
    await add(accountA, '2026-10-03', -100, { override: 'Groceries' })
    await add(accountA, '2026-10-04', 300_000, { rule: 'Wages and salary' })
    await add(accountA, '2026-10-05', -700)

    expect(await loans()).toEqual([lent, repaid])
  })

  it('leaves out a Transfer, but takes in a half of one that the Admin gave a Loans Category, as lending to a tracked Account does', async () => {
    const { out, into } = await pair('2026-10-05', 5000)
    expect(await loans()).toEqual([])

    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id IN (?, ?)').bind(ids['Loans'], out, into).run()

    expect(await loans()).toEqual([out, into])
  })

  it('leaves out a Transaction in a removed Loans Category', async () => {
    await add(accountA, '2026-10-02', -50_000, { override: 'Loans' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Loans'").run()

    expect(await loans()).toEqual([])
  })
})

describe('what it reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day). A range is read off the date index, so Transactions outside it cost nothing, and each one
  // inside costs its index entry, its row and a Category lookup for each source that names one: 4 when an Override and a Rule both do.
  const reads = async (range: Parameters<typeof buildSpending>[0]) => {
    const { sql, binds } = buildSpending(range)
    const result = await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()
    return { rows: result.results, reads: (result.meta as { rows_read: number }).rows_read }
  }

  beforeEach(async () => {
    // 3,000 Transactions of history from 2020, none in the ranges below.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Fuel'])
      .run()
  })

  it('reads the Transactions of a month and not the history around it', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 400)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2026-10-01', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Groceries'])
      .run()

    const { rows, reads: n } = await reads({ from: '2026-10-01', to: '2026-10-31' })

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Groceries'], categoryName: 'Groceries', kind: 'spending', outCents: 40_000, inCents: 0 }])
    expect(n).toBeLessThanOrEqual(400 * 3 + 20) // index entry, row and the Override's Category
  })

  it('reads four rows for a Transaction that has both an Override and a Rule, over a range of 12 months', async () => {
    // 40 a month for a year, all with both: the Override's Category is used, and the Rule's is still looked up.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 479)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT ?, date('2026-01-01', '+' || (i / 40) || ' months', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ?, ? FROM seq`,
    )
      .bind(accountA, ids['Groceries'], ids['Fuel'])
      .run()

    const { rows, reads: n } = await reads({ from: '2026-01-01', to: '2026-12-31' })

    expect(rows).toHaveLength(12)
    expect(rows.every((r) => r.categoryId === ids['Groceries'] && r.outCents === 4000)).toBe(true)
    expect(n).toBeLessThanOrEqual(480 * 4 + 20)
    expect(n).toBeGreaterThan(480 * 3) // the Rule's Category is read too, so the allowance above is not slack for a cheaper plan
  })

  it("reads only the named Account's Transactions through its own date index", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 600)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT CASE WHEN i % 10 = 0 THEN ? ELSE ? END, date('2026-10-01', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountB, accountA, ids['Groceries'])
      .run()

    const { rows, reads: n } = await reads({ from: '2026-10-01', to: '2026-10-31', accountId: accountB })

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Groceries'], categoryName: 'Groceries', kind: 'spending', outCents: 6000, inCents: 0 }])
    expect(n).toBeLessThanOrEqual(60 * 3 + 20) // its 60 Transactions, not the other 540 on the same days
  })
})
