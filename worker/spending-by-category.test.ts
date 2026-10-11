import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { rollUp, type SpendingRow } from './spending'
import { readSpendingByCategory, spendingByCategory, UNCATEGORISED_NAME } from './spending-by-category'

// Spending by Category (spending-by-category.ts), the one function the chart and a Report of it share. First with no database, from the rows
// `buildSpending` gives; then against D1, for one Account as a Report asks about it. What counts as Spending is tested in spending.test.ts, and the
// chart's Worker boundary in charts.test.ts. All the figures are made up.

const row = (month: string, categoryId: number | null, categoryName: string | null, kind: SpendingRow['kind'], outCents: number, inCents = 0): SpendingRow => ({
  month,
  categoryId,
  categoryName,
  kind,
  outCents,
  inCents,
})
const range = { from: '2026-09-01', to: '2026-10-31' }

describe('spendingByCategory', () => {
  it('adds a Category\'s months together, names it, and puts the most first', () => {
    const result = spendingByCategory(range, [
      row('2026-09', 1, 'Groceries', 'spending', 10_000, 500),
      row('2026-10', 1, 'Groceries', 'spending', 7_000),
      row('2026-10', 2, 'Fuel', 'spending', 20_000),
    ])

    expect(result).toEqual({
      ...range,
      totalCents: 9_500 + 7_000 + 20_000,
      categories: [
        { categoryId: 2, name: 'Fuel', cents: 20_000 },
        { categoryId: 1, name: 'Groceries', cents: 16_500 }, // a refund of $5.00 comes off September
      ],
    })
  })

  it('leaves out Income and Loans, which are not Spending', () => {
    const result = spendingByCategory(range, [
      row('2026-10', 1, 'Groceries', 'spending', 1_000),
      row('2026-10', 3, 'Wages and salary', 'income', 0, 400_000),
      row('2026-10', 4, 'Loan – Alice', 'loans', 50_000),
    ])

    expect(result.categories.map((c) => c.name)).toEqual(['Groceries'])
    expect(result.totalCents).toBe(1_000)
  })

  it('names Uncategorised, which counts as Spending, and puts it after the named Categories when the amounts tie', () => {
    const result = spendingByCategory(range, [row('2026-10', null, null, 'spending', 3_000), row('2026-10', 5, 'Eating out', 'spending', 3_000), row('2026-10', 1, 'Groceries', 'spending', 3_000)])

    expect(result.categories).toEqual([
      { categoryId: 5, name: 'Eating out', cents: 3_000 },
      { categoryId: 1, name: 'Groceries', cents: 3_000 },
      { categoryId: null, name: UNCATEGORISED_NAME, cents: 3_000 },
    ])
  })

  it('puts Uncategorised by its size, not always last: the order is the figures\'s, with a tie going to the named Category', () => {
    const result = spendingByCategory(range, [row('2026-10', null, null, 'spending', 9_000), row('2026-10', 1, 'Groceries', 'spending', 3_000), row('2026-10', 2, 'Zoo', 'spending', 20)])

    expect(result.categories.map((c) => c.name)).toEqual([UNCATEGORISED_NAME, 'Groceries', 'Zoo'])
  })

  it('orders equal amounts by name ignoring capitals and accents, and by Category ID for two with one name', () => {
    const result = spendingByCategory(range, [
      row('2026-10', 4, 'zebra', 'spending', 500),
      row('2026-10', 3, 'Bananas', 'spending', 500),
      row('2026-10', 2, 'apples', 'spending', 500),
      row('2026-10', 9, 'Āpples', 'spending', 500),
      row('2026-10', 8, 'Bananas', 'spending', 500),
    ])

    expect(result.categories.map((c) => [c.name, c.categoryId])).toEqual([['apples', 2], ['Āpples', 9], ['Bananas', 3], ['Bananas', 8], ['zebra', 4]])
  })

  it('takes the total from rollUp, and the Categories\' figures add up to it', () => {
    const rows = [row('2026-09', 1, 'Groceries', 'spending', 4000, 700), row('2026-10', 1, 'Groceries', 'spending', 100), row('2026-10', null, null, 'spending', 0, 250), row('2026-10', 3, 'Wages and salary', 'income', 0, 9_000)]

    const result = spendingByCategory(range, rows)

    expect(result.totalCents).toBe(rollUp(rows).totals.spendingCents)
    expect(result.categories.reduce((sum, c) => sum + c.cents, 0)).toBe(result.totalCents)
  })

  it('puts a Category that took in more than it paid out last, below zero, and counts it in the total', () => {
    const result = spendingByCategory(range, [row('2026-10', 1, 'Groceries', 'spending', 1_000), row('2026-10', 2, 'Fuel', 'spending', 0, 2_500)])

    expect(result.categories).toEqual([
      { categoryId: 1, name: 'Groceries', cents: 1_000 },
      { categoryId: 2, name: 'Fuel', cents: -2_500 },
    ])
    expect(result.totalCents).toBe(-1_500)
  })

  it('is empty, with a total of nothing, when there is no spending', () => {
    expect(spendingByCategory(range, [])).toEqual({ ...range, totalCents: 0, categories: [] })
  })

  it('keeps the Account a Report asked about, with the dates', () => {
    expect(spendingByCategory({ ...range, accountId: 7 }, [])).toEqual({ ...range, accountId: 7, totalCents: 0, categories: [] })
  })

  it('refuses a row with an ID and no name rather than show the Category as something else', () => {
    expect(() => spendingByCategory(range, [{ month: '2026-10', categoryId: 99, kind: 'spending', outCents: 100, inCents: 0 }])).toThrow('no name')
    expect(() => spendingByCategory(range, [row('2026-10', 99, null, 'spending', 100)])).toThrow('no name')
  })
})

describe('readSpendingByCategory', () => {
  let everyday = 0
  let savings = 0
  const ids: Record<string, number> = {}

  const add = (account: number, date: string, amountCents: number, override?: string) =>
    env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(account, date, amountCents, 'EXAMPLE SHOP', 'import', override ? ids[override]! : null)
      .run()

  beforeEach(async () => {
    await env.DB.batch(['budgets', 'transactions', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
    await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
    const [a, b] = await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
      env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example savings') RETURNING id"),
    ])
    everyday = (a!.results[0] as { id: number }).id
    savings = (b!.results[0] as { id: number }).id
    for (const name of ['Groceries', 'Fuel']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
  })

  it('reads all the Accounts, or one when the range names it, in one statement', async () => {
    await add(everyday, '2026-10-02', -4000, 'Groceries')
    await add(everyday, '2026-10-03', -9000, 'Fuel')
    await add(savings, '2026-10-04', -1000, 'Groceries')

    const all = await readSpendingByCategory(env.DB, { from: '2026-10-01', to: '2026-10-31' })
    const one = await readSpendingByCategory(env.DB, { from: '2026-10-01', to: '2026-10-31', accountId: savings })

    expect(all.categories.map((c) => [c.name, c.cents])).toEqual([['Fuel', 9000], ['Groceries', 5000]])
    expect(all.totalCents).toBe(14_000)
    expect(one.categories.map((c) => [c.name, c.cents])).toEqual([['Groceries', 1000]])
    expect(one).toMatchObject({ accountId: savings, totalCents: 1000 })
  })

  it('names a Category as it is shown: the next one when one is removed, and Uncategorised when none is left, with no lookup that can miss', async () => {
    await add(everyday, '2026-10-02', -4000, 'Fuel')
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()

    expect((await readSpendingByCategory(env.DB, { from: '2026-10-01', to: '2026-10-31' })).categories).toEqual([{ categoryId: null, name: UNCATEGORISED_NAME, cents: 4000 }])
  })
})
