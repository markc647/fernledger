import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import { MAX_INCOME_MONTHS as PAGE_MAX_INCOME_MONTHS } from '../src/lib/income-vs-spending'
import { monthEnd, nzMonth } from './months'
import type { BudgetReport } from './report-budget'
import { incomeVsSpending, MAX_INCOME_MONTHS, type IncomeVsSpending } from './report-income-vs-spending'
import { buildSpending, rollUp, type SpendingRow } from './spending'
import type { SpendingByCategory } from './spending-by-category'

// Seam 1: the income-vs-spending-by-month Report's data (GET /api/reports/income-vs-spending), through the Worker's exported handler as the local-development
// Admin or a read-only Member (the dev identity cookie is honoured on localhost only). The Report decides nothing about what is Spending or Income: it is
// `rollUp`'s months and totals for `buildSpending`'s rows (spending.ts, ADR 0012), with a row of zeros for a month that has nothing in it. So the tests here are about
// what the Report asks of it (the Account, the dates, the Account that does not exist), that its figures are those of `rollUp` and of every other place that
// totals Spending, and that nothing which is not Spending or Income gets in. All the data is made up (bank 99).
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
async function report(over: Record<string, string | undefined> = {}, who: Who = 'member'): Promise<IncomeVsSpending> {
  const res = await call(`/api/reports/income-vs-spending?${query(over)}`, who)
  expect(res.status, JSON.stringify(over)).toBe(200)
  return res.json()
}
/** The Report's months as `[month, income, spending, difference]`, in the order it gives them. */
const lines = (r: IncomeVsSpending) => r.months.map((m) => [m.month, m.incomeCents, m.spendingCents, m.differenceCents])

beforeEach(async () => {
  await env.DB.batch(['budgets', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
  const [a, b] = await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example savings') RETURNING id"),
  ])
  accountA = (a!.results[0] as { id: number }).id
  accountB = (b!.results[0] as { id: number }).id
  for (const name of ['Groceries', 'Fuel', 'Eating out', 'Tax', 'Wages and salary', 'Interest', 'Loans']) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

describe('what the Report totals', () => {
  it('gives Income and Spending for each month, oldest first, with the difference and the totals', async () => {
    await add(accountA, '2026-09-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-09-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-09-30', -30_000, { override: 'Tax' })
    await add(accountA, '2026-10-01', 310_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-02', -2550, { override: 'Groceries' })
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-10-20', 1200, { override: 'Interest' })
    await add(accountB, '2026-11-10', -1500, { override: 'Eating out' })

    const r = await report({ from: '2026-09-01', to: '2026-11-30' })

    expect(lines(r)).toEqual([
      ['2026-09', 300_000, 34_000, 266_000],
      ['2026-10', 311_200, 11_550, 299_650],
      ['2026-11', 0, 1500, -1500],
    ])
    expect(r.totals).toMatchObject({ incomeCents: 611_200, spendingCents: 47_050, differenceCents: 564_150 })
    expect(r).toMatchObject({ from: '2026-09-01', to: '2026-11-30' })
    expect(r).not.toHaveProperty('accountId') // every Account
  })

  it('takes money back, such as a refund, off Spending, and money out of an Income Category off Income, each going below zero when the other way round', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-20', 1000, { override: 'Groceries' }) // a refund
    await add(accountA, '2026-10-03', 250_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-04', -250_000, { override: 'Wages and salary' }) // the wages paid back
    await add(accountA, '2026-10-05', -700, { override: 'Interest' }) // only money out of an Income Category
    await add(accountA, '2026-11-02', 2500, { override: 'Fuel' }) // only money back

    const r = await report({ from: '2026-10-01', to: '2026-11-30' })

    expect(lines(r)).toEqual([
      ['2026-10', -700, 3000, -3700],
      ['2026-11', 0, -2500, 2500],
    ])
    expect(r.totals).toMatchObject({ incomeCents: -700, spendingCents: 500, differenceCents: -1200 })
  })

  it('counts money in that has no Category as Spending that comes off it, and money out with none as Spending', async () => {
    await add(accountA, '2026-10-04', -700)
    await add(accountA, '2026-10-06', 300) // a payment in nobody has given a Category: it counts against Spending (ADR 0012)

    const r = await report()

    expect(lines(r)).toEqual([['2026-10', 0, 400, -400]])
  })

  it('counts what is in a removed Category as Uncategorised, which is Spending', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-03', 5000, { override: 'Interest' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name IN ('Fuel', 'Interest')").run()

    expect(lines(await report())).toEqual([['2026-10', 0, -4900, 4900]])
  })

  it('takes the kind from the Category an Override gives, over a Rule\'s', async () => {
    await add(accountA, '2026-10-02', 2000, { override: 'Interest', rule: 'Groceries' })
    await add(accountA, '2026-10-03', 900, { override: 'Groceries', rule: 'Wages and salary' })
    await add(accountA, '2026-10-04', 100_000, { rule: 'Wages and salary' }) // a Rule alone gives Income too

    expect(lines(await report())).toEqual([['2026-10', 102_000, -900, 102_900]])
  })

  it('has a row of zeros for a month with nothing in it, so a gap is not mistaken for missing data', async () => {
    await add(accountA, '2026-08-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-11-10', 5000, { override: 'Interest' })

    const r = await report({ from: '2026-08-01', to: '2026-11-30' })

    expect(lines(r)).toEqual([
      ['2026-08', 0, 4000, -4000],
      ['2026-09', 0, 0, 0],
      ['2026-10', 0, 0, 0],
      ['2026-11', 5000, 0, 5000],
    ])
    expect(r.totals).toMatchObject({ incomeCents: 5000, spendingCents: 4000, differenceCents: 1000 })
  })

  it('is a row of zeros for each month, and zero totals, for dates with no Transactions', async () => {
    await add(accountA, '2026-09-30', -4000, { override: 'Groceries' })

    const r = await report({ from: '2026-10-01', to: '2026-11-30' })

    // Whether a month is over depends on the day the test runs (the calendar describe below fixes it), so the months are not compared whole.
    expect(r).toMatchObject({ from: '2026-10-01', to: '2026-11-30', totals: { incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 } })
    expect(r.months.map(({ state: _state, ...figures }) => figures)).toEqual([
      { month: '2026-10', incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 },
      { month: '2026-11', incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 },
    ])
  })

  it('counts only the dates asked for in a month it covers in part, both ends included, and a single day is a range', async () => {
    await add(accountA, '2026-09-30', -1, { override: 'Fuel' })
    await add(accountA, '2026-10-01', -10, { override: 'Fuel' })
    await add(accountA, '2026-10-15', 4000, { override: 'Interest' })
    await add(accountA, '2026-10-31', -100, { override: 'Fuel' })
    await add(accountA, '2026-11-01', -1000, { override: 'Fuel' })
    await add(accountA, '2026-11-14', -10_000, { override: 'Fuel' })
    await add(accountA, '2026-11-15', -100_000, { override: 'Fuel' })

    expect(lines(await report({ from: '2026-10-01', to: '2026-11-14' }))).toEqual([
      ['2026-10', 4000, 110, 3890],
      ['2026-11', 0, 11_000, -11_000],
    ])
    expect(lines(await report({ from: '2026-10-31', to: '2026-10-31' }))).toEqual([['2026-10', 0, 100, -100]])
  })

  it('spans the end of a year, and reads each date as the NZ date it is', async () => {
    await add(accountA, '2026-12-31', -100, { override: 'Fuel' })
    await add(accountA, '2027-01-01', -200, { override: 'Fuel' })
    await add(accountA, '2027-01-02', -400, { override: 'Fuel' })

    expect(lines(await report({ from: '2026-12-31', to: '2027-01-01' }))).toEqual([
      ['2026-12', 0, 100, -100],
      ['2027-01', 0, 200, -200],
    ])
  })

  it('has a row for every month the dates touch, up to the most a Report covers, oldest first and none twice', async () => {
    const r = await report({ from: '2000-01-01', to: '2009-12-31' })

    expect(r.months).toHaveLength(MAX_INCOME_MONTHS)
    expect(r.months[0]!.month).toBe('2000-01')
    expect(r.months.at(-1)!.month).toBe('2009-12')
    const names = r.months.map((m) => m.month)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers 120 months, 10 years, and the page and the Worker say so alike', () => {
    expect(MAX_INCOME_MONTHS).toBe(120)
    expect(PAGE_MAX_INCOME_MONTHS).toBe(MAX_INCOME_MONTHS)
  })
})

describe('what was counted, apart from what the figures come to', () => {
  it('counts a month of $40 spent and refunded, which nets out to nothing, and not a month of only a Transfer and a loan', async () => {
    await add(accountA, '2026-09-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-09-20', 4000, { override: 'Groceries' }) // refunded in full
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-20', -50_000, { override: 'Loans' })

    const r = await report({ from: '2026-09-01', to: '2026-10-31' })

    expect(lines(r)).toEqual([['2026-09', 0, 0, 0], ['2026-10', 0, 0, 0]]) // both come to nothing
    expect(r.months.map((m) => m.counted)).toEqual([1, 0]) // but one has Transactions that count and the other has none
    expect(r.totals.counted).toBe(1)
  })

  it('counts each Category with something in the month, Uncategorised as one, and adds them up for all the dates', async () => {
    await add(accountA, '2026-10-02', -100, { override: 'Groceries' })
    await add(accountA, '2026-10-03', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-04', 5000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-05', -700)
    await add(accountA, '2026-11-05', -200, { override: 'Groceries' })

    const r = await report({ from: '2026-10-01', to: '2026-11-30' })

    expect(r.months.map((m) => m.counted)).toEqual([4, 1])
    expect(r.totals.counted).toBe(5)
  })
})

describe('money in that has no Category', () => {
  it('is added up for each month and for all the dates, and is in Spending as money back, not in Income', async () => {
    await add(accountA, '2026-09-04', -900) // money out with no Category: Spending, and not money in
    await add(accountA, '2026-09-05', 1500) // money in with no Category
    await add(accountA, '2026-09-20', 500)
    await add(accountA, '2026-10-06', 300)
    await add(accountA, '2026-10-02', 250_000, { override: 'Wages and salary' }) // money in with a Category is not counted here
    await add(accountA, '2026-10-03', 1000, { override: 'Groceries' }) // nor is a refund into a Spending Category

    const r = await report({ from: '2026-09-01', to: '2026-10-31' })

    expect(r.months.map((m) => [m.month, m.uncategorisedInCents])).toEqual([['2026-09', 2000], ['2026-10', 300]])
    expect(r.totals.uncategorisedInCents).toBe(2300)
    expect(lines(r)).toEqual([
      ['2026-09', 0, -1100, 1100], // $9.00 out, less $20.00 in
      ['2026-10', 250_000, -1300, 251_300], // the $3.00, and the $10.00 refund, both come off Spending
    ])
  })

  it('does not change the Difference whichever Category the money in is given', async () => {
    await add(accountA, '2026-10-06', 4000)
    const before = (await report()).totals
    expect(before.uncategorisedInCents).toBe(4000)

    await env.DB.prepare('UPDATE transactions SET override_category = ?').bind(ids['Interest']).run()
    const after = (await report()).totals

    expect(after.uncategorisedInCents).toBe(0)
    expect(after.incomeCents - before.incomeCents).toBe(4000) // now it is Income
    expect(after.spendingCents - before.spendingCents).toBe(4000) // and Spending is no longer reduced by it
    expect(after.differenceCents).toBe(before.differenceCents)
  })

  it("is none when nothing came in with no Category, and counts a removed Category's money in", async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    expect((await report()).totals.uncategorisedInCents).toBe(0)

    await add(accountA, '2026-10-03', 700, { override: 'Fuel' })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Fuel'").run()
    expect((await report()).totals.uncategorisedInCents).toBe(700) // a removed Category has fallen through to Uncategorised
  })

  it('leaves out money in that is a Transfer, a loan, outside the dates or in another Account than the one asked about', async () => {
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-06', 300, { ruleTransfer: true })
    await add(accountA, '2026-10-07', 800, { override: 'Loans' })
    await add(accountA, '2026-11-01', 1200)
    await add(accountB, '2026-10-09', 60)

    expect((await report()).totals.uncategorisedInCents).toBe(60)
    expect((await report({ accountId: String(accountA) })).totals.uncategorisedInCents).toBe(0)
    expect((await report({ accountId: String(accountB) })).totals.uncategorisedInCents).toBe(60)
  })
})

describe('which months are over', () => {
  it('says each month is over, is the one it is now, or has not begun, by the NZ month it is now', async () => {
    const now = nzMonth(new Date())
    const far = await report({ from: '2000-01-01', to: '2000-03-31' })
    expect(far.months.map((m) => m.state)).toEqual(['ended', 'ended', 'ended'])

    const future = await report({ from: '2100-01-01', to: '2100-02-28' })
    expect(future.months.map((m) => m.state)).toEqual(['not-begun', 'not-begun'])

    const current = await report({ from: `${now}-01`, to: monthEnd(now) }) // dates that run to the end of the month, so past today
    expect(current.months.map((m) => [m.month, m.state])).toEqual([[now, 'under-way']])
  })
})

describe('what is not Spending or Income', () => {
  it('leaves out both halves of a paired Transfer, and a Transaction a Rule marks as a Transfer', async () => {
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-06', -7000, { ruleTransfer: true })
    await add(accountA, '2026-10-07', 300, { ruleTransfer: true }) // money in marked a Transfer is not Income, nor money back
    await add(accountA, '2026-10-07', -300, { override: 'Fuel' })

    const r = await report()

    expect(lines(r)).toEqual([['2026-10', 0, 300, -300]])
    expect(r.totals.spendingCents).toBe(300)
  })

  it('leaves out a Transfer even when a Rule would have given it a Category', async () => {
    const { out, into } = await pair('2026-10-07', 1200)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids['Groceries'], out).run()
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids['Wages and salary'], into).run()

    expect((await report()).totals).toMatchObject({ incomeCents: 0, spendingCents: 0, differenceCents: 0 })
  })

  it('counts the half of a Transfer the Admin gave a Category under that Category\'s kind, which is not always Spending, and still leaves out the other half', async () => {
    const { out, into } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Fuel'], out).run()
    expect(lines(await report())).toEqual([['2026-10', 0, 5000, -5000]])

    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Interest'], into).run()
    expect(lines(await report())).toEqual([['2026-10', 5000, 5000, 0]]) // now each half counts under its own Category's kind
  })

  it('counts both halves of a pair the Admin says is Not a Transfer under their own Categories, Uncategorised when they have none', async () => {
    const { out, into } = await pair('2026-10-05', 5000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids['Wages and salary'], into).run()
    expect((await report()).totals).toMatchObject({ incomeCents: 5000, spendingCents: 0, differenceCents: 5000 }) // only the half with a Category, while the pair stands

    const marked = await exports.default.fetch(
      new Request(`${origin}/api/transactions/${out}/not-transfer`, { method: 'POST', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
    )
    expect(marked.status).toBe(200)

    expect(lines(await report())).toEqual([['2026-10', 5000, 5000, 0]]) // the money out is Uncategorised, which is Spending
  })

  it('leaves out a Loans Category, and the Transfer of a loan between tracked Accounts that has a Loans Category on both halves', async () => {
    await add(accountA, '2026-10-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-03', -50_000, { override: 'Loans' })
    await add(accountA, '2026-10-04', 10_000, { rule: 'Loans' })
    const { out, into } = await pair('2026-10-05', 20_000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id IN (?, ?)').bind(ids['Loans'], out, into).run()
    await add(accountA, '2026-10-06', -300, { override: 'Fuel' })

    const r = await report()

    expect(lines(r)).toEqual([['2026-10', 300_000, 300, 299_700]])
    expect(r.totals).toMatchObject({ incomeCents: 300_000, spendingCents: 300, differenceCents: 299_700 })
  })

  it('follows a change of a Category\'s kind at once, for every month, since the kind is not stored on the Transaction', async () => {
    await add(accountA, '2026-09-10', -100, { override: 'Fuel' })
    await add(accountA, '2026-10-11', -200, { override: 'Groceries' })
    await env.DB.prepare("UPDATE categories SET kind = 'income' WHERE name = 'Fuel'").run()
    try {
      expect(lines(await report({ from: '2026-09-01' }))).toEqual([['2026-09', -100, 0, -100], ['2026-10', 0, 200, -200]])
      await env.DB.prepare("UPDATE categories SET kind = 'loans' WHERE name = 'Fuel'").run()
      expect(lines(await report({ from: '2026-09-01' }))).toEqual([['2026-09', 0, 0, 0], ['2026-10', 0, 200, -200]])
    } finally {
      await env.DB.prepare("UPDATE categories SET kind = 'spending' WHERE name = 'Fuel'").run()
    }
    expect(lines(await report({ from: '2026-09-01' }))).toEqual([['2026-09', 0, 100, -100], ['2026-10', 0, 200, -200]])
  })

  // A Pending Transaction is stored apart from `transactions` (spec #1), and Sync, which stores them, is not built yet, so there is nothing to
  // test with. The Sync ticket adds the table and must turn this into a test with a Pending Transaction in the same dates and Category
  // (spending.test.ts and report-spending.test.ts have the same one).
  it.todo('leaves out a Pending Transaction')
})

describe('one Account or all of them', () => {
  beforeEach(async () => {
    await add(accountA, '2026-10-01', 200_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-02', -1000, { override: 'Groceries' })
    await add(accountB, '2026-10-03', -250, { override: 'Groceries' })
    await add(accountB, '2026-10-04', 75, { override: 'Interest' })
    await add(accountB, '2026-10-05', -40)
    await pair('2026-10-06', 5000)
  })

  it('totals every Account when none is named', async () => {
    const r = await report()
    expect(lines(r)).toEqual([['2026-10', 200_075, 1290, 198_785]])
    expect(r).not.toHaveProperty('accountId')
  })

  it('totals only the Account named, and says which', async () => {
    const savings = await report({ accountId: String(accountB) })
    expect(lines(savings)).toEqual([['2026-10', 75, 290, -215]]) // the $50.00 that came in is a Transfer
    expect(savings.accountId).toBe(accountB)

    const everyday = await report({ accountId: String(accountA) })
    expect(lines(everyday)).toEqual([['2026-10', 200_000, 1000, 199_000]]) // and so is the $50.00 that went out
  })

  it('is a 404 for an Account that does not exist, not a Report of zeros', async () => {
    const res = await call(`/api/reports/income-vs-spending?${query({ accountId: String(accountB + 1000) })}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('the same figures as everywhere else that totals Spending and Income (ADR 0012)', () => {
  /** A few months of everything that is and is not Spending or Income, across two Accounts. */
  async function history() {
    await add(accountA, '2026-09-10', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-02', -2550, { override: 'Groceries' })
    await add(accountA, '2026-10-20', 1000, { override: 'Groceries' })
    await add(accountB, '2026-10-05', -2000, { rule: 'Groceries' })
    await add(accountA, '2026-10-05', -9000, { override: 'Fuel' })
    await add(accountA, '2026-11-04', -3000, { override: 'Fuel' })
    await add(accountB, '2026-11-10', -1500, { override: 'Eating out' })
    await add(accountA, '2026-09-30', -30_000, { override: 'Tax' })
    await add(accountA, '2026-10-04', -700)
    await add(accountA, '2026-10-06', 300)
    await add(accountA, '2026-09-01', 300_000, { override: 'Wages and salary' })
    await add(accountA, '2026-10-01', 300_000, { override: 'Wages and salary' })
    await add(accountB, '2026-11-15', 1200, { rule: 'Interest' })
    await add(accountA, '2026-11-16', -200, { override: 'Interest' })
    await add(accountA, '2026-10-03', -50_000, { override: 'Loans' })
    await pair('2026-10-05', 5000)
    await add(accountA, '2026-10-08', -7000, { ruleTransfer: true })
  }

  /** What `rollUp` makes of `buildSpending`, run here directly against D1 (no Report in between). */
  async function direct(range: { from: string; to: string; accountId?: number }) {
    const { sql, binds } = buildSpending(range)
    const rows = (await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()).results
    return rollUp(rows)
  }

  const ranges = [
    ['all three months', { from: '2026-09-01', to: '2026-11-30' }],
    ['one month', { from: '2026-10-01', to: '2026-10-31' }],
    ['part of a month', { from: '2026-10-02', to: '2026-10-20' }],
    ['one day', { from: '2026-10-05', to: '2026-10-05' }],
    ['dates with nothing in them', { from: '2025-01-01', to: '2025-12-31' }],
  ] as const

  it.each(ranges)("gives, for %s, what rollUp's months and totals give for buildSpending's rows", async (_what, range) => {
    await history()
    const expected = await direct(range)

    const r = await report(range)

    // Every month `rollUp` has is a month of the Report, with its figures; the Report's others are zeros.
    const byMonth = new Map(r.months.map((m) => [m.month, m]))
    for (const month of expected.months) expect(byMonth.get(month.month), month.month).toMatchObject({ incomeCents: month.incomeCents, spendingCents: month.spendingCents })
    const known = new Set(expected.months.map((m) => m.month))
    for (const month of r.months.filter((m) => !known.has(m.month))) expect(month, month.month).toMatchObject({ incomeCents: 0, spendingCents: 0, differenceCents: 0 })
    expect(r.totals).toMatchObject(expected.totals)
  })

  it.each([
    ['one Account', 'a'],
    ['the other Account', 'b'],
  ] as const)("gives, for %s, what rollUp's totals give for buildSpending's rows", async (_what, which) => {
    await history()
    const accountId = which === 'a' ? accountA : accountB
    const range = { from: '2026-09-01', to: '2026-11-30' }

    const r = await report({ ...range, accountId: String(accountId) })

    expect(r.totals).toMatchObject((await direct({ ...range, accountId })).totals)
  })

  it.each(ranges)("has months that add up to the totals, and a difference that is Income less Spending in each, for %s", async (_what, range) => {
    await history()

    const r = await report(range)

    expect(r.months.reduce((sum, m) => sum + m.incomeCents, 0)).toBe(r.totals.incomeCents)
    expect(r.months.reduce((sum, m) => sum + m.spendingCents, 0)).toBe(r.totals.spendingCents)
    for (const m of [...r.months, r.totals]) expect(m.differenceCents).toBe(m.incomeCents - m.spendingCents)
    if (range.from === '2026-09-01') expect(r.totals.incomeCents).toBeGreaterThan(0) // the history does have something to compare
  })

  // The Dashboard's chart and the Spending by Category Report total Spending with the same functions, so for the same dates the Spending this Report totals is
  // theirs. This holds it to them: a Report that kept its own idea of Spending would fail.
  it.each(ranges)('gives, for %s, the Spending total /api/charts/spending and the Spending by Category Report give', async (_what, range) => {
    await history()

    const r = await report(range)
    const chart = (await (await call(`/api/charts/spending?from=${range.from}&to=${range.to}`)).json()) as SpendingByCategory
    const byCategory = (await (await call(`/api/reports/spending?from=${range.from}&to=${range.to}`)).json()) as SpendingByCategory

    expect(r.totals.spendingCents).toBe(chart.totalCents)
    expect(r.totals.spendingCents).toBe(byCategory.totalCents)
  })

  it('gives for a month what Budget vs actual spent: each Category with a Budget, the rest together, and Uncategorised', async () => {
    await history()
    for (const name of ['Groceries', 'Tax']) {
      const set = await exports.default.fetch(
        new Request(`${origin}/api/budgets/${ids[name]}`, { method: 'PUT', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ effectiveFrom: '2026-10', amountCents: 10_000 }) }),
      )
      expect(set.status).toBe(200)
    }
    const vsActual = (await (await call('/api/budgets/vs-actual?month=2026-10')).json()) as { rows: { spentCents: number }[]; otherCents: number; uncategorisedCents: number }

    const r = await report({ from: '2026-10-01', to: '2026-10-31' })

    expect(vsActual.rows).toHaveLength(2)
    expect(r.months).toHaveLength(1)
    expect(r.months[0]!.spendingCents).toBe(vsActual.rows.reduce((sum, row) => sum + row.spentCents, 0) + vsActual.otherCents + vsActual.uncategorisedCents)
  })

  it('gives, for whole months, the Spending /api/reports/budget-vs-actual gives for each of them', async () => {
    await history()
    const range = { from: '2026-09-01', to: '2026-11-30' }

    const r = await report(range)
    const budget = (await (await call(`/api/reports/budget-vs-actual?from=${range.from}&to=${range.to}`)).json()) as BudgetReport

    expect(budget.months.map((m) => [m.month, m.spentCents])).toEqual(r.months.map((m) => [m.month, m.spendingCents]))
    expect(r.months.every((m) => m.spendingCents !== 0)).toBe(true) // each month has something to compare
  })
})

describe('the calendar, with no database (incomeVsSpending)', () => {
  const row = (month: string, kind: SpendingRow['kind'], outCents: number, inCents: number): SpendingRow => ({ month, categoryId: 1, categoryName: 'A', kind, outCents, inCents })

  it('puts a month rollUpMonths has no row for among the others in order, with zeros, and takes the rest from it', () => {
    const range = { from: '2026-01-15', to: '2026-04-02' }
    const rows = [row('2026-01', 'spending', 500, 100), row('2026-03', 'income', 20, 1000), row('2026-03', 'loans', 9999, 0)]

    expect(incomeVsSpending(range, rows, '2026-03-10')).toEqual({
      ...range,
      months: [
        { month: '2026-01', state: 'ended', incomeCents: 0, spendingCents: 400, differenceCents: -400, uncategorisedInCents: 0, counted: 1 },
        { month: '2026-02', state: 'ended', incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 },
        { month: '2026-03', state: 'under-way', incomeCents: 980, spendingCents: 0, differenceCents: 980, uncategorisedInCents: 0, counted: 1 }, // the loan is not counted
        { month: '2026-04', state: 'not-begun', incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 },
      ],
      totals: { incomeCents: 980, spendingCents: 400, differenceCents: 580, uncategorisedInCents: 0, counted: 2 },
    })
  })

  it('is one month for dates in one month, and carries its Account', () => {
    const range = { from: '2026-10-05', to: '2026-10-05', accountId: 7 }
    expect(incomeVsSpending(range, [], '2026-10-20').months.map((m) => m.month)).toEqual(['2026-10'])
    expect(incomeVsSpending(range, [], '2026-10-20')).toMatchObject({ accountId: 7 })
  })

  it('crosses the end of a year', () => {
    expect(incomeVsSpending({ from: '2025-11-30', to: '2026-02-01' }, [], '2026-01-31').months.map((m) => [m.month, m.state])).toEqual([
      ['2025-11', 'ended'],
      ['2025-12', 'ended'],
      ['2026-01', 'under-way'],
      ['2026-02', 'not-begun'],
    ])
  })

  it('says the month it is now is over for dates that ended before today, and under way for dates that reach it', () => {
    const state = (from: string, to: string, today: string) => incomeVsSpending({ from, to }, [], today).months.map((m) => [m.month, m.state])

    expect(state('2026-10-01', '2026-10-15', '2026-10-20')).toEqual([['2026-10', 'ended']]) // 1 to 15 October, opened on the 20th: those dates are over
    expect(state('2026-10-01', '2026-10-20', '2026-10-20')).toEqual([['2026-10', 'under-way']]) // up to and including today
    expect(state('2026-10-01', '2026-10-19', '2026-10-20')).toEqual([['2026-10', 'ended']])
    expect(state('2026-10-01', '2026-10-31', '2026-10-20')).toEqual([['2026-10', 'under-way']])
    expect(state('2026-09-10', '2026-10-15', '2026-10-20')).toEqual([['2026-09', 'ended'], ['2026-10', 'ended']])
    expect(state('2026-10-01', '2026-11-15', '2026-10-20')).toEqual([['2026-10', 'under-way'], ['2026-11', 'not-begun']])
    expect(state('2026-10-31', '2026-10-31', '2026-10-31')).toEqual([['2026-10', 'under-way']]) // the last day
  })

  it('counts a month whose figures net out to nothing, apart from a month with nothing counted', () => {
    const range = { from: '2026-01-01', to: '2026-03-31' }
    const rows = [row('2026-01', 'spending', 4000, 4000), row('2026-03', 'loans', 500, 0)] // $40 spent and fully refunded; a loan

    const r = incomeVsSpending(range, rows, '2026-06-01')

    expect(r.months.map((m) => [m.month, m.spendingCents, m.counted])).toEqual([['2026-01', 0, 1], ['2026-02', 0, 0], ['2026-03', 0, 0]])
    expect(r.totals).toMatchObject({ spendingCents: 0, incomeCents: 0, counted: 1 }) // something was counted, so the Report has a row for January and not "nothing"
  })
})

describe('who can read it, and what a request refuses', () => {
  it('gives every Member the same Report as the Admin', async () => {
    await add(accountA, '2026-10-02', -4000, { override: 'Groceries' })
    await add(accountA, '2026-10-03', 9000, { override: 'Wages and salary' })
    expect(await report({}, 'admin')).toEqual(await report({}, 'member'))
    expect(lines(await report({}, 'member'))).toEqual([['2026-10', 9000, 4000, 5000]])
  })

  it('is closed to anyone who is not signed in', async () => {
    expect((await call(`/api/reports/income-vs-spending?${query()}`, null)).status).toBe(401)
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
    ['dates that touch more than 120 months', { from: '2000-01-31', to: '2010-01-01' }, 'to'],
    ['an Account that is not a number', { accountId: 'x' }, 'accountId'],
    ['an Account with a sign', { accountId: '-1' }, 'accountId'],
    ['an Account of zero', { accountId: '0' }, 'accountId'],
    ['an Account with too many digits', { accountId: '1234567890123456' }, 'accountId'],
    ['an Account that is empty', { accountId: '' }, 'accountId'],
  ])('refuses %s', async (_what, over, field) => {
    const res = await call(`/api/reports/income-vs-spending?${query(over)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
  })

  it('takes an Account of fifteen digits, the most an ID has, and says there is no such Account', async () => {
    const res = await call(`/api/reports/income-vs-spending?${query({ accountId: '999999999999999' })}`)
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
    const res = await worker.fetch!(new Request(`${origin}/api/reports/income-vs-spending?${query(over)}`, { headers: { Cookie: 'fernledger_dev_as=member' } }) as never, { ...env, DB: db }, ctx)
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

  it('is one D1 query for all Accounts, and two for one (the check that it exists), however many Transactions and months', async () => {
    const all = metered()
    const res = await requestWith(all.db, { from: '2026-01-01', to: '2026-12-31' })
    expect(res.status).toBe(200)
    expect(all.usage.queries).toBe(1)

    const one = metered()
    expect((await requestWith(one.db, { from: '2026-01-01', to: '2026-12-31', accountId: String(accountA) })).status).toBe(200)
    expect(one.usage.queries).toBe(2)

    const long = metered()
    expect((await requestWith(long.db, { from: '2000-01-01', to: '2009-12-31' })).status).toBe(200) // the most months a Report covers are still one query
    expect(long.usage.queries).toBe(1)
  })

  it('reads the Transactions of the dates asked for, four rows each, and not the history around them', async () => {
    const { db, usage } = metered()

    const res = await requestWith(db, { from: '2026-01-01', to: '2026-12-31' })

    const r = (await res.json()) as IncomeVsSpending
    expect(r.totals).toMatchObject({ incomeCents: 0, spendingCents: 48_000, differenceCents: -48_000 })
    expect(r.months).toHaveLength(12)
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
  })
})
