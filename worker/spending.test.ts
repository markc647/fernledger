import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSpending, spentCents, type SpendingRow } from './spending'

// The one definition of spending (spending.ts), tested directly against D1. How Budgets use it, through the real request
// path, is in budgets.test.ts. All the data is made up (bank 99).

let accountA = 0
let accountB = 0
const ids: Record<string, number> = {}

type Extra = { override?: string; rule?: string; ruleTransfer?: boolean; pairedWith?: number }
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

async function spending(fromMonth: string, toMonth = fromMonth): Promise<SpendingRow[]> {
  const { sql, binds } = buildSpending({ fromMonth, toMonth })
  return (await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()).results
}

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
  for (const name of ['Groceries', 'Fuel', 'Eating out', 'Wages and salary']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

describe('spending by month and Category', () => {
  it('totals money out and money in apart, by NZ month and the Category the Transaction is in', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', -1550, { override: 'Groceries' })
    await add(accountA, '2026-10-21', 1000, { override: 'Groceries' }) // a refund
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-09-30', -777, { override: 'Groceries' })

    const rows = await spending('2026-09', '2026-10')

    expect(of(rows, '2026-10', 'Groceries')).toEqual([5550, 1000])
    expect(of(rows, '2026-10', 'Fuel')).toEqual([9000, 0])
    expect(of(rows, '2026-09', 'Groceries')).toEqual([777, 0])
    expect(rows).toHaveLength(3)
  })

  it('takes the Category from the Override, then the Rule, and leaves the rest Uncategorised', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { rule: 'Groceries' })
    await add(accountA, '2026-10-04', -400)

    const rows = await spending('2026-10')

    expect(of(rows, '2026-10', 'Fuel')).toEqual([100, 0])
    expect(of(rows, '2026-10', 'Groceries')).toEqual([200, 0])
    expect(of(rows, '2026-10', null)).toEqual([400, 0])
  })

  it('counts a Transaction in a removed Category under the next one that names a Category in use, or as Uncategorised', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel', rule: 'Groceries' })
    await add(accountA, '2026-10-03', -200, { override: 'Fuel' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()

    const rows = await spending('2026-10')

    expect(of(rows, '2026-10', 'Groceries')).toEqual([100, 0])
    expect(of(rows, '2026-10', null)).toEqual([200, 0])
    expect(of(rows, '2026-10', 'Fuel')).toBeUndefined()
  })

  it('reads a Transaction date as the NZ date it is, so the last and first days of a month fall where they should', async () => {
    await add(accountA, '2026-09-30', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-01', -200, { override: 'Fuel' })
    await add(accountA, '2026-10-31', -400, { override: 'Fuel' })
    await add(accountA, '2026-11-01', -800, { override: 'Fuel' })

    const rows = await spending('2026-10')

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], outCents: 600, inCents: 0 }])
  })

  it('covers every month in the range and none outside it, oldest first', async () => {
    for (const date of ['2026-07-31', '2026-08-01', '2026-09-15', '2026-10-31', '2026-11-01']) await add(accountA, date, -100, { override: 'Fuel' })

    expect((await spending('2026-08', '2026-10')).map((r) => r.month)).toEqual(['2026-08', '2026-09', '2026-10'])
  })

  it('spans the end of a year', async () => {
    await add(accountA, '2026-12-31', -100, { override: 'Fuel' })
    await add(accountA, '2027-01-01', -200, { override: 'Fuel' })

    expect((await spending('2026-12', '2027-01')).map((r) => [r.month, r.outCents])).toEqual([['2026-12', 100], ['2027-01', 200]])
  })
})

describe('what is not spending', () => {
  it('leaves out both halves of a paired Transfer', async () => {
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    const rows = await spending('2026-10')

    expect(rows).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], outCents: 300, inCents: 0 }])
  })

  it('leaves out a Transaction a Rule marks as a Transfer when nothing paired it, even though the Rule gave it no Category', async () => {
    await add(accountA, '2026-10-05', -7000, { ruleTransfer: true })
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    expect(await spending('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], outCents: 300, inCents: 0 }])
  })

  it('leaves out a Transfer even when a Rule would have given it a Category', async () => {
    await add(accountA, '2026-10-05', -7000, { ruleTransfer: true, rule: 'Groceries' })
    const { out } = await pair('2026-10-07', 1200)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids['Groceries'], out).run()

    expect(await spending('2026-10')).toEqual([])
  })

  it("counts a half of a Transfer as spending in the Category the Admin chose for it, and still leaves out the other half", async () => {
    const { out } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Fuel'], out).run()

    expect(await spending('2026-10')).toEqual([{ month: '2026-10', categoryId: ids['Fuel'], outCents: 5000, inCents: 0 }])
  })

  it('counts money sent to an account that is not tracked, which has nothing to pair with', async () => {
    await add(accountA, '2026-10-05', -5000, { override: 'Eating out' })

    expect(of(await spending('2026-10'), '2026-10', 'Eating out')).toEqual([5000, 0])
  })

  it('reads only settled Transactions: Pending Transactions are stored apart (spec #1) and never part of spending', () => {
    // When Sync adds the table for Pending Transactions this must not change, and its ticket proves it with a Pending Transaction in a seam test.
    const { sql } = buildSpending({ fromMonth: '2026-10', toMonth: '2026-10' })
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase())
    expect([...new Set(tables)].sort()).toEqual(['categories', 'transactions'])
  })
})

describe('spentCents', () => {
  it('is money out less money in, so a refund reduces what a Category shows as spent', () => {
    expect(spentCents({ outCents: 5550, inCents: 1000 })).toBe(4550)
    expect(spentCents({ outCents: 0, inCents: 0 })).toBe(0)
  })

  it('is below zero when a month has more money in than out', () => {
    expect(spentCents({ outCents: 0, inCents: 250_000 })).toBe(-250_000)
  })
})

describe('what it reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day). A month is read off the date index, so Transactions in other
  // months cost nothing, and each one in the month costs its index entry, its row and its Category lookups.
  const OTHER = 3000
  const IN_MONTH = 400
  beforeEach(async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${OTHER})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Fuel'])
      .run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${IN_MONTH})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category)
       SELECT ?, date('2026-10-01', '+' || (i % 28) || ' days'), -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(accountA, ids['Groceries'])
      .run()
  })

  it("reads a month's Transactions and not the history around it", async () => {
    const { sql, binds } = buildSpending({ fromMonth: '2026-10', toMonth: '2026-10' })
    const result = await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()

    expect(result.results).toEqual([{ month: '2026-10', categoryId: ids['Groceries'], outCents: IN_MONTH * 100, inCents: 0 }])
    expect((result.meta as { rows_read: number }).rows_read).toBeLessThanOrEqual(IN_MONTH * 4 + 50)
  })
})
