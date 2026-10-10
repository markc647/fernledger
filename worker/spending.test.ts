import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSpending, rollUp, type SpendingRow } from './spending'

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

  it('reads a Transaction date as the NZ date it is, so the last and first days of a month fall where they should', async () => {
    await add(accountA, '2026-09-30', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-01', -200, { override: 'Fuel' })
    await add(accountA, '2026-10-31', -400, { override: 'Fuel' })
    await add(accountA, '2026-11-01', -800, { override: 'Fuel' })

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], kind: 'spending', outCents: 600, inCents: 0 }])
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

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], kind: 'spending', outCents: 300, inCents: 0 }])
  })

  it('leaves out a Transaction a Rule marks as a Transfer when nothing paired it', async () => {
    await add(accountA, '2026-10-05', -7000, { ruleTransfer: true })
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], kind: 'spending', outCents: 300, inCents: 0 }])
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

    expect(await inMonth('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], kind: 'spending', outCents: 5000, inCents: 0 }])
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
  const row = (month: string, categoryId: number | null, kind: SpendingRow['kind'], outCents: number, inCents: number): SpendingRow => ({ month, categoryId, kind, outCents, inCents })

  it('works out Spending as money out less money in, and Income as money in less money out', () => {
    const { categories } = rollUp([
      row('2026-10', 1, 'spending', 5550, 1000), // a refund comes off
      row('2026-10', 2, 'income', 250, 300_000), // money out of an Income Category comes off
      row('2026-10', null, 'spending', 700, 0),
    ])

    expect(categories).toEqual([
      { month: '2026-10', categoryId: 1, kind: 'spending', cents: 4550 },
      { month: '2026-10', categoryId: 2, kind: 'income', cents: 299_750 },
      { month: '2026-10', categoryId: null, kind: 'spending', cents: 700 },
    ])
  })

  it('goes below zero when more came back than went out, or more went out of an Income Category than came in', () => {
    const { categories, months } = rollUp([row('2026-10', 1, 'spending', 0, 1500), row('2026-10', 2, 'income', 800, 0)])

    expect(categories.map((c) => c.cents)).toEqual([-1500, -800])
    expect(months).toEqual([{ month: '2026-10', spendingCents: -1500, incomeCents: -800 }])
  })

  it('leaves a Loans Category out of everything', () => {
    const { categories, months } = rollUp([row('2026-10', 1, 'spending', 1000, 0), row('2026-10', 3, 'loans', 50_000, 20_000), row('2026-11', 3, 'loans', 0, 5_000)])

    expect(categories).toEqual([{ month: '2026-10', categoryId: 1, kind: 'spending', cents: 1000 }])
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

  it('has nothing for no rows', () => {
    expect(rollUp([])).toEqual({ categories: [], months: [] })
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

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Groceries'], kind: 'spending', outCents: 40_000, inCents: 0 }])
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

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Groceries'], kind: 'spending', outCents: 6000, inCents: 0 }])
    expect(n).toBeLessThanOrEqual(60 * 3 + 20) // its 60 Transactions, not the other 540 on the same days
  })
})
