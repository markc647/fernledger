import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isLoansKind as browserIsLoansKind, LOANS as BROWSER_LOANS } from '../src/lib/category-kinds'
import { LOANS_PAGE_SIZE as PAGE_LOANS_PAGE_SIZE } from '../src/lib/report-loans'
import worker from './index'
import { CATEGORY_KINDS, isLoansKind, LOANS } from './category-kinds'
import { buildLoanOpening, LOANS_PAGE_SIZE, type LoanPage, type LoanRow } from './report-loans'
import { buildSpending, rollUp, type SpendingRow } from './spending'
import type { SpendingByCategory } from './spending-by-category'
import { keepReport } from './test-support'

// Seam 1: the Loans Report's data (GET /api/reports/loans), through the Worker's exported handler as the local-development Admin or a read-only Member (the dev
// identity cookie is honoured on localhost only). It lists one Loans Category's Transactions; what a loan is comes from `isLoan` and the effective Category
// (spending.ts, effective-category.ts), so these tests hold it to the shared spending definition: whatever the Report lists as a loan, `buildSpending` sets aside
// as Loans, and no spending, income or Budget figure counts it. All the data is made up (bank 99).
const origin = 'http://localhost:5173'
type Who = 'admin' | 'member'

// The Admin reads any Report; a Member only one that has been kept (kept-reports.test.ts).
async function call(path: string, who: Who | null = 'admin') {
  // Without a sign-in the request comes from a host that is not localhost, where the dev identity is never honoured.
  return exports.default.fetch(new Request(`${who ? origin : 'https://app.test'}${path}`, { headers: who ? { Cookie: `fernledger_dev_as=${who}` } : {} }))
}

let parent = 0 // the Account the parent lends from
let child = 0 // the Account of a child, which the parent also tracks
const ids: Record<string, number> = {}
const ALICE = 'Loan – Alice'
const BEN = 'Loan – Ben'

type Extra = { override?: string; rule?: string; ruleTransfer?: boolean; note?: string; description?: string }
/** Adds a made-up Transaction and returns its ID. `override` and `rule` name a Category. */
async function add(account: number, date: string, amountCents: number, extra: Extra = {}) {
  const { meta } = await env.DB.prepare(
    'INSERT INTO transactions (account_id, date, amount_cents, description, source, note, override_category, rule_category, rule_transfer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(account, date, amountCents, extra.description ?? 'EXAMPLE PAYMENT', 'import', extra.note ?? null, extra.override ? ids[extra.override]! : null, extra.rule ? ids[extra.rule]! : null, extra.ruleTransfer ? 1 : null)
    .run()
  return meta.last_row_id
}

/** Two Transactions that are each other's matching Transaction: a paired Transfer from the parent's Account into the child's. */
async function pair(date: string, amountCents: number) {
  const out = await add(parent, date, -amountCents)
  const into = await add(child, date, amountCents)
  await env.DB.batch([env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(into, out), env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(out, into)])
  return { out, into }
}

const query = (over: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries({ categoryId: String(ids[ALICE]), to: '2026-10-31', ...over })) if (value !== undefined) params.set(name, value)
  return params.toString()
}
async function page(over: Record<string, string | undefined> = {}, who: Who = 'admin'): Promise<LoanPage> {
  const res = await call(`/api/reports/loans?${query(over)}`, who)
  expect(res.status, JSON.stringify(over)).toBe(200)
  return res.json()
}
/** The Category's Transactions as `[date, cents]`, oldest first. */
const lines = (p: LoanPage) => p.transactions.map((t) => [t.date, t.amountCents])
const named = (name: string, over: Record<string, string | undefined> = {}) => page({ categoryId: String(ids[name]), ...over })

type CategoryRecord = { id: number; name: string; kind: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name, kind FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['kept_reports', 'budgets', 'transactions', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name, kind) VALUES (?, ?, ?)').bind(c.id, c.name, c.kind)))
  for (const c of starters) ids[c.name] = c.id
  for (const name of [ALICE, BEN]) ids[name] = (await env.DB.prepare("INSERT INTO categories (name, kind) VALUES (?, 'loans') RETURNING id").bind(name).first<{ id: number }>())!.id
  const [a, b] = await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-91', 'Example everyday') RETURNING id"),
    env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-92', 'Example child savings') RETURNING id"),
  ])
  parent = (a!.results[0] as { id: number }).id
  child = (b!.results[0] as { id: number }).id
})

describe('what the Report lists', () => {
  it('lists the Category\'s lending and repayments, oldest first, across Accounts, with the Account, the description and the Note', async () => {
    const repaid = await add(child, '2026-09-10', 20_000, { override: ALICE, description: 'EXAMPLE REPAYMENT', note: 'First payment back' })
    const lent = await add(parent, '2026-08-01', -50_000, { override: ALICE, description: 'EXAMPLE LOAN' })

    const p = await page()

    expect(p.category).toEqual({ id: ids[ALICE], name: ALICE })
    expect(p.transactions).toEqual([
      { id: lent, date: '2026-08-01', description: 'EXAMPLE LOAN', amountCents: -50_000, accountName: 'Example everyday', note: null },
      { id: repaid, date: '2026-09-10', description: 'EXAMPLE REPAYMENT', amountCents: 20_000, accountName: 'Example child savings', note: 'First payment back' },
    ])
    expect(p.next).toBeNull()
  })

  it('lists one Category\'s Transactions and no other Category\'s, Uncategorised ones or other Loans Categories', async () => {
    const alice = await add(parent, '2026-08-01', -50_000, { override: ALICE })
    await add(parent, '2026-08-02', -30_000, { override: BEN })
    await add(parent, '2026-08-03', -4000, { override: 'Groceries' })
    await add(parent, '2026-08-04', -700)
    await add(parent, '2026-08-05', -100, { override: 'Loans' }) // the starter Loans Category is another loan

    expect((await page()).transactions.map((t) => t.id)).toEqual([alice])
    expect(lines(await named(BEN))).toEqual([['2026-08-02', -30_000]])
  })

  it('takes a Transaction by the Category a Rule gave it, an Override over a Rule\'s, and an Override away from a Rule\'s', async () => {
    const byRule = await add(parent, '2026-08-01', -10_000, { rule: ALICE })
    const byOverride = await add(parent, '2026-08-02', -20_000, { override: ALICE, rule: 'Groceries' })
    await add(parent, '2026-08-03', -40_000, { override: 'Groceries', rule: ALICE }) // the Admin put it elsewhere

    expect((await page()).transactions.map((t) => t.id)).toEqual([byRule, byOverride])
  })

  it('gives a Transaction to its Rule\'s Category when its Override\'s Category was removed, as every list of Transactions does', async () => {
    const fellThrough = await add(parent, '2026-08-01', -10_000, { override: BEN, rule: ALICE })
    expect((await page()).transactions).toEqual([]) // Ben's Override outranks the Rule while Ben's Category is in use

    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE id = ?").bind(ids[BEN]).run()

    expect((await page()).transactions.map((t) => t.id)).toEqual([fellThrough])
  })

  it('is a 404 for a Loans Category that was removed', async () => {
    await add(parent, '2026-08-02', -20_000, { override: ALICE })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE id = ?").bind(ids[ALICE]).run()

    expect((await call(`/api/reports/loans?${query()}`)).status).toBe(404)
  })

  it('lists money in and money out together, with the sign each has', async () => {
    await add(parent, '2026-08-01', -50_000, { override: ALICE })
    await add(parent, '2026-09-01', 12_345, { override: ALICE })
    expect(lines(await page())).toEqual([['2026-08-01', -50_000], ['2026-09-01', 12_345]])
  })

  it('breaks a tie on date by ID, oldest first', async () => {
    const first = await add(parent, '2026-08-01', -100, { override: ALICE })
    const second = await add(parent, '2026-08-01', -200, { override: ALICE })
    const third = await add(parent, '2026-08-01', -300, { override: ALICE })
    expect((await page()).transactions.map((t) => t.id)).toEqual([first, second, third])
  })

  it('is empty, with nothing owed, for a Category with no Transactions', async () => {
    expect(await page()).toEqual({ category: { id: ids[ALICE], name: ALICE }, opening: { cents: 0, count: 0 }, transactions: [], next: null })
  })
})

describe('Transfers', () => {
  it('leaves out both halves of a paired Transfer, and one a Rule marks, whatever Category a Rule would have given them', async () => {
    const { out } = await pair('2026-08-05', 5000)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids[ALICE], out).run()
    const marked = await add(parent, '2026-08-06', -7000, { rule: ALICE, ruleTransfer: true })

    expect((await page()).transactions).toEqual([])
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids[ALICE], marked).run()
    expect((await page()).transactions.map((t) => t.id)).toEqual([marked]) // once the Admin gives it the Category it is a loan
  })

  it('lists a half of a Transfer that the Admin gave the Category, as lending to a tracked Account does, and not the other half', async () => {
    const { out, into } = await pair('2026-08-05', 20_000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids[ALICE], out).run()

    expect((await page()).transactions.map((t) => t.id)).toEqual([out])

    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids[ALICE], into).run()
    expect((await page()).transactions.map((t) => t.id)).toEqual([out, into])
  })

  it('lists a Transaction the Admin marked Not a Transfer under its own Category, and each half of the pair under its own', async () => {
    const { out, into } = await pair('2026-08-05', 20_000)
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids[ALICE], out).run()
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(ids[BEN], into).run()
    expect((await page()).transactions).toEqual([]) // while the pair stands, neither half has a Category

    const marked = await exports.default.fetch(
      new Request(`${origin}/api/transactions/${into}/not-transfer`, { method: 'POST', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
    )
    expect(marked.status).toBe(200)

    expect((await page()).transactions.map((t) => t.id)).toEqual([out])
    expect((await named(BEN)).transactions.map((t) => t.id)).toEqual([into])
  })

  // A Pending Transaction is stored apart from `transactions` (spec #1), and Sync, which stores them, is not built yet, so there is nothing to test with. The Sync
  // ticket adds the table and must turn this into a test with a Pending Transaction in the Category (spending.test.ts and report-spending.test.ts have the same one).
  it.todo('leaves out a Pending Transaction')
})

describe('the dates', () => {
  beforeEach(async () => {
    await add(parent, '2026-07-31', -50_000, { override: ALICE })
    await add(parent, '2026-08-01', -10_000, { override: ALICE })
    await add(parent, '2026-08-31', 4000, { override: ALICE })
    await add(parent, '2026-09-01', 2500, { override: ALICE })
  })

  it('goes from the first Transaction up to the date, both included, when no start date is given, and has no opening balance', async () => {
    const p = await page({ to: '2026-08-31' })
    expect(lines(p)).toEqual([['2026-07-31', -50_000], ['2026-08-01', -10_000], ['2026-08-31', 4000]])
    expect(p.opening).toEqual({ cents: 0, count: 0 })
  })

  it('starts at the start date, which is included, and adds up everything before it as the opening balance', async () => {
    const p = await page({ from: '2026-08-01', to: '2026-08-31' })
    expect(lines(p)).toEqual([['2026-08-01', -10_000], ['2026-08-31', 4000]])
    expect(p.opening).toEqual({ cents: -50_000, count: 1 })
  })

  it('has an opening balance of everything before a start date that is after every Transaction, and no rows', async () => {
    const p = await page({ from: '2026-10-01', to: '2026-10-31' })
    expect(p.transactions).toEqual([])
    expect(p.opening).toEqual({ cents: -50_000 - 10_000 + 4000 + 2500, count: 4 })
  })

  it('makes a single day a range, and takes the opening balance from the day before', async () => {
    const p = await page({ from: '2026-08-31', to: '2026-08-31' })
    expect(lines(p)).toEqual([['2026-08-31', 4000]])
    expect(p.opening).toEqual({ cents: -60_000, count: 2 })
  })

  it('counts only the Category\'s own Transactions, and no Transfer, in the opening balance', async () => {
    await add(parent, '2026-07-01', -999, { override: BEN })
    await add(parent, '2026-07-02', -888)
    await pair('2026-07-03', 7777)
    const { out } = await pair('2026-07-04', 6000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids[ALICE], out).run() // lending to the child's tracked Account

    expect((await page({ from: '2026-08-01' })).opening).toEqual({ cents: -50_000 - 6000, count: 2 })
  })

  it('reads each date as the NZ date it is, across the end of a year', async () => {
    await add(parent, '2026-12-31', -100, { override: ALICE })
    await add(parent, '2027-01-01', -200, { override: ALICE })
    const p = await page({ from: '2026-12-31', to: '2027-01-01' })
    expect(lines(p)).toEqual([['2026-12-31', -100], ['2027-01-01', -200]])
    expect(p.opening?.cents).toBe(-50_000 - 10_000 + 4000 + 2500)
  })
})

describe('paging', () => {
  it('pages through a loan without repeating or skipping a Transaction, even inside one date, and gives the opening balance on the first page only', async () => {
    const all = [
      await add(parent, '2026-08-01', -100, { override: ALICE }),
      await add(parent, '2026-08-02', -200, { override: ALICE }),
      await add(parent, '2026-08-02', -300, { override: ALICE }),
      await add(parent, '2026-08-02', -400, { override: ALICE }),
      await add(parent, '2026-08-03', -500, { override: ALICE }),
    ]
    await add(parent, '2026-07-01', -1000, { override: ALICE })

    const first = await page({ from: '2026-08-01', limit: '2' })
    expect(first.transactions.map((t) => t.id)).toEqual(all.slice(0, 2))
    expect(first.next).toBe(`2026-08-02:${all[1]}`)
    expect(first.opening).toEqual({ cents: -1000, count: 1 })

    const second = await page({ from: '2026-08-01', limit: '2', after: first.next! })
    expect(second.transactions.map((t) => t.id)).toEqual(all.slice(2, 4))
    expect(second.opening).toBeNull()

    const third = await page({ from: '2026-08-01', limit: '2', after: second.next! })
    expect(third.transactions.map((t) => t.id)).toEqual(all.slice(4))
    expect(third.next).toBeNull()
  })

  it('has no next page when the page holds exactly what is left', async () => {
    await add(parent, '2026-08-01', -100, { override: ALICE })
    await add(parent, '2026-08-02', -100, { override: ALICE })
    const p = await page({ limit: '2' })
    expect(p.transactions).toHaveLength(2)
    expect(p.next).toBeNull()
  })

  it('keeps a page to the size asked for, at most the Loans Report\'s page of 1,000 (larger than the Transaction listing\'s 200), and at least one', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${LOANS_PAGE_SIZE + 20})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category) SELECT ?, '2026-08-01', -100, 'EXAMPLE ' || i, 'import', ? FROM seq`,
    )
      .bind(parent, ids[ALICE])
      .run()
    expect((await page({ limit: '1' })).transactions).toHaveLength(1)
    expect((await page({ limit: '0' })).transactions).toHaveLength(1)
    const huge = await page({ limit: '100000' })
    expect(huge.transactions).toHaveLength(LOANS_PAGE_SIZE)
    expect(huge.next).not.toBeNull()
    expect((await page()).transactions).toHaveLength(LOANS_PAGE_SIZE) // and that is the page when none is asked for
  })

  it('uses the page size the Report page asks for (the page keeps its own copy), 1,000: the loan is re-read for every page, so a page is large', () => {
    expect(PAGE_LOANS_PAGE_SIZE).toBe(LOANS_PAGE_SIZE)
    expect(LOANS_PAGE_SIZE).toBe(1000)
  })
})

describe('only a Loans Category', () => {
  it.each([
    ['a Spending Category', 'Groceries'],
    ['an Income Category', 'Wages and salary'],
  ])('is a 404 for %s, which is not a loan, even when it has Transactions', async (_what, name) => {
    await add(parent, '2026-08-01', -4000, { override: name })
    const res = await call(`/api/reports/loans?${query({ categoryId: String(ids[name]) })}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('follows a change of the Category\'s kind at once: a Category that stops being Loans has no Report, and one that becomes Loans has', async () => {
    await add(parent, '2026-08-01', -4000, { override: 'Groceries' })
    expect((await call(`/api/reports/loans?${query({ categoryId: String(ids['Groceries']) })}`)).status).toBe(404)
    await env.DB.prepare("UPDATE categories SET kind = 'loans' WHERE name = 'Groceries'").run()
    expect(lines(await named('Groceries'))).toEqual([['2026-08-01', -4000]])
    await env.DB.prepare("UPDATE categories SET kind = 'spending' WHERE name = 'Groceries'").run()
    expect((await call(`/api/reports/loans?${query({ categoryId: String(ids['Groceries']) })}`)).status).toBe(404)
  })

  it('means by a Loans Category what the pages mean: the browser\'s LOANS and isLoansKind are the Worker\'s, for every kind', () => {
    expect(BROWSER_LOANS).toBe(LOANS)
    for (const kind of CATEGORY_KINDS) expect(browserIsLoansKind(kind), kind).toBe(isLoansKind(kind))
  })

  it('is a 404 for a Category that does not exist, and for one of fifteen digits, the most an ID has', async () => {
    expect((await call(`/api/reports/loans?${query({ categoryId: String(ids[ALICE] + 1000) })}`)).status).toBe(404)
    expect((await call(`/api/reports/loans?${query({ categoryId: '999999999999999' })}`)).status).toBe(404)
  })
})

describe('who can read it, and what a request refuses', () => {
  it('gives a Member the same Report as the Admin, once the Admin has kept it', async () => {
    await add(parent, '2026-08-01', -50_000, { override: ALICE, note: 'A note' })
    await keepReport('loans', { to: '2026-10-31' })
    expect(await page({}, 'admin')).toEqual(await page({}, 'member'))
    expect(lines(await page({}, 'member'))).toEqual([['2026-08-01', -50_000]])
  })

  it('is closed to anyone who is not signed in', async () => {
    expect((await call(`/api/reports/loans?${query()}`, null)).status).toBe(401)
  })

  // The refusal names the field and never a value: values can be Transaction data.
  it.each([
    ['no Category', { categoryId: undefined }, 'categoryId'],
    ['a Category that is not a number', { categoryId: 'x' }, 'categoryId'],
    ['a Category with a sign', { categoryId: '-1' }, 'categoryId'],
    ['a Category of zero', { categoryId: '0' }, 'categoryId'],
    ['a Category with a leading zero', { categoryId: '01' }, 'categoryId'],
    ['a Category with too many digits', { categoryId: '1234567890123456' }, 'categoryId'],
    ['a Category that is empty', { categoryId: '' }, 'categoryId'],
    ['no To date', { to: undefined }, 'to'],
    ['a To date that is not a day', { to: '2026-02-30' }, 'to'],
    ['a To date outside the years accepted', { to: '2101-01-01' }, 'to'],
    ['a From date that is not a day', { from: '2026-02-30' }, 'from'],
    ['a From date that is not a date', { from: 'soon' }, 'from'],
    ['a From date that is empty', { from: '' }, 'from'],
    ['a From date before the years accepted', { from: '1999-12-31' }, 'from'],
    ['a range that ends before it starts', { from: '2026-11-01', to: '2026-10-01' }, 'to'],
    ['a place to continue from that is not one', { after: 'soon' }, 'after'],
    ['a place to continue from with an impossible date', { after: '2026-13-01:5' }, 'after'],
    ['a place to continue from with a zero ID', { after: '2026-10-01:0' }, 'after'],
    ['a page size that is not a number', { limit: '-5' }, 'limit'],
  ])('refuses %s', async (_what, over, field) => {
    const res = await call(`/api/reports/loans?${query(over)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
  })
})

describe('the same loans as everywhere else that sets Loans apart from Spending and Income (ADR 0012)', () => {
  /** Every way a Transaction can be in a Loans Category, and every way it cannot, across two Accounts and two Loans Categories, with spending and income beside them. */
  async function history() {
    await add(parent, '2026-08-01', -50_000, { override: ALICE }) // lent
    await add(parent, '2026-08-20', 10_000, { rule: ALICE }) // repaid, by a Rule
    await add(child, '2026-09-05', 15_000, { override: ALICE }) // repaid into the other Account
    await add(parent, '2026-08-03', -30_000, { override: BEN })
    await add(parent, '2026-08-04', -777, { override: ALICE, rule: 'Groceries' })
    await add(parent, '2026-08-05', -888, { override: 'Groceries', rule: ALICE }) // the Admin put it back in Spending
    const lending = await pair('2026-09-10', 20_000)
    await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(ids[BEN], lending.out).run() // one half of a Transfer given a Loans Category
    await pair('2026-09-11', 5000) // a plain Transfer
    const marked = await pair('2026-09-12', 3000) // the Admin says it was not a Transfer: both halves count under their own Category, a Rule's Loans Category for each
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id IN (?, ?)').bind(ids[ALICE], marked.out, marked.into).run()
    const notTransfer = await exports.default.fetch(
      new Request(`${origin}/api/transactions/${marked.out}/not-transfer`, { method: 'POST', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
    )
    expect(notTransfer.status).toBe(200)
    await add(parent, '2026-08-06', -7000, { rule: ALICE, ruleTransfer: true }) // a Rule's Transfer: not a loan
    await add(parent, '2026-08-07', -4000, { override: 'Groceries' })
    await add(parent, '2026-08-08', -700)
    await add(parent, '2026-08-09', 300_000, { override: 'Wages and salary' })
    await add(parent, '2026-07-01', -1234, { override: ALICE }) // before the range below
  }

  const RANGE = { from: '2026-08-01', to: '2026-09-30' }

  /** What the Report lists for one Category over the range, paged until it has no more, as money out and money in. */
  async function listed(name: string) {
    const rows: LoanRow[] = []
    let after: string | undefined
    do {
      const p = await named(name, { ...RANGE, limit: '2', ...(after ? { after } : {}) })
      rows.push(...p.transactions)
      after = p.next ?? undefined
    } while (after)
    return {
      rows,
      outCents: rows.filter((r) => r.amountCents < 0).reduce((sum, r) => sum - r.amountCents, 0),
      inCents: rows.filter((r) => r.amountCents > 0).reduce((sum, r) => sum + r.amountCents, 0),
    }
  }

  async function setAside() {
    const { sql, binds } = buildSpending(RANGE)
    const rows = (await env.DB.prepare(sql).bind(...binds).all<SpendingRow>()).results
    return { rows, loans: rows.filter((r) => isLoansKind(r.kind)) }
  }

  it('lists exactly the Transactions buildSpending sets aside as Loans: the same money out and money in for each Loans Category', async () => {
    await history()
    const { loans } = await setAside()
    expect(loans.length).toBeGreaterThan(2) // the history does have loans to compare

    for (const name of [ALICE, BEN]) {
      const mine = loans.filter((r) => r.categoryId === ids[name])
      const report = await listed(name)
      expect(report.outCents, name).toBe(mine.reduce((sum, r) => sum + r.outCents, 0))
      expect(report.inCents, name).toBe(mine.reduce((sum, r) => sum + r.inCents, 0))
      expect(report.rows.length, name).toBeGreaterThan(0)
    }
    // And the arithmetic, by hand, so the comparison above is not two copies of one mistake.
    // Alice: $500.00 lent, $7.77 (an Override over a Rule's Groceries) and the $30.00 half of a pair marked Not a Transfer; $100.00 and $150.00 paid back, and that pair's other half.
    expect(await listed(ALICE)).toMatchObject({ outCents: 50_000 + 777 + 3000, inCents: 10_000 + 15_000 + 3000 })
    // Ben: $300.00 lent, and the half of a $200.00 Transfer the Admin gave his Category (its other half, in the child's Account, is still a Transfer).
    expect(await listed(BEN)).toMatchObject({ outCents: 30_000 + 20_000, inCents: 0 })
  })

  it('has a loan in no Spending or Income figure: rollUp, the Dashboard\'s chart, the spending Report and Budget vs actual all leave it out', async () => {
    await history()
    const { rows } = await setAside()
    const rolled = rollUp(rows)

    // What Spending and Income are without a single loan: the Groceries Transaction the Admin put back in Spending ($8.88) and the other ($40.00), the one with no Category
    // ($7.00), and the wages. The loans' $500.00, $300.00, $200.00 and the rest are in no figure.
    expect(rolled.byCategory.map((c) => c.categoryName).sort()).toEqual(['Groceries', null, 'Wages and salary'].sort())
    expect(rolled.totals).toEqual({ spendingCents: 888 + 4000 + 700, incomeCents: 300_000 })
    expect(rolled.categories.some((c) => c.categoryId === ids[ALICE] || c.categoryId === ids[BEN] || c.categoryId === ids['Loans'])).toBe(false)

    const chart = (await (await call(`/api/charts/spending?${new URLSearchParams(RANGE)}`)).json()) as SpendingByCategory
    const report = (await (await call(`/api/reports/spending?${new URLSearchParams(RANGE)}`)).json()) as SpendingByCategory
    for (const spending of [chart, report]) {
      expect(spending.totalCents).toBe(rolled.totals.spendingCents)
      expect(spending.categories.map((c) => c.name)).not.toContain(ALICE)
      expect(spending.categories.map((c) => c.name)).not.toContain(BEN)
    }

    const vsActual = (await (await call('/api/budgets/vs-actual?month=2026-08')).json()) as { rows: { categoryId: number }[]; otherCents: number; uncategorisedCents: number }
    expect(vsActual.rows.map((r) => r.categoryId)).not.toContain(ids[ALICE])
    // August's Spending is the Groceries Transaction the Admin put back, the other one, and the one with no Category; none of the loans' $500.00, $300.00 or $77.70.
    expect(vsActual.otherCents + vsActual.uncategorisedCents).toBe(888 + 4000 + 700)

    // And the Budget vs actual Report, for the months the loans fall in: August holds the loans' $500.00 and the rest, September their repayments and the lending by Transfer.
    const budgets = (await (await call('/api/reports/budget-vs-actual?from=2026-08-01&to=2026-09-30')).json()) as {
      months: { month: string; rows: { categoryId: number }[]; otherCents: number; uncategorisedCents: number; spentCents: number }[]
      total: { spentCents: number; otherCents: number; uncategorisedCents: number }
    }
    expect(budgets.months.map((m) => [m.month, m.spentCents])).toEqual([['2026-08', 888 + 4000 + 700], ['2026-09', 0]])
    expect(budgets.months.flatMap((m) => m.rows.map((r) => r.categoryId))).not.toContain(ids[ALICE])
    expect(budgets.total.spentCents).toBe(888 + 4000 + 700)
    expect(budgets.total.otherCents + budgets.total.uncategorisedCents).toBe(888 + 4000 + 700)
  })

  it('would count the same Transactions as Spending if their Category were Spending, which is what leaving out a loan is', async () => {
    await history()
    const before = rollUp((await setAside()).rows).totals.spendingCents
    await env.DB.prepare("UPDATE categories SET kind = 'spending' WHERE id = ?").bind(ids[ALICE]).run()
    try {
      expect(rollUp((await setAside()).rows).totals.spendingCents).toBeGreaterThan(before)
    } finally {
      await env.DB.prepare("UPDATE categories SET kind = 'loans' WHERE id = ?").bind(ids[ALICE]).run()
    }
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
          if (property === 'all' || property === 'run') {
            return async () => {
              const result = await (target[property] as () => Promise<{ meta: unknown }>)()
              usage.rowsRead += (result.meta as { rows_read: number }).rows_read
              return result
            }
          }
          if (property === 'first') {
            // `first` returns only the row, so what it read is found by running the statement as `all`, which reads the same.
            return async (column?: string) => {
              const result = await target.all()
              usage.rowsRead += (result.meta as { rows_read: number }).rows_read
              const row = (result.results[0] as Record<string, unknown> | undefined) ?? null
              return column === undefined ? row : (row?.[column] ?? null)
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
    const res = await worker.fetch!(new Request(`${origin}/api/reports/loans?${query(over)}`, { headers: { Cookie: 'fernledger_dev_as=admin' } }) as never, { ...env, DB: db }, ctx)
    await waitOnExecutionContext(ctx)
    return res
  }

  const LOAN = 300 // Transactions in Alice's Category: a long loan, with an Override on each and a Rule's Category on a third of them
  const PER_TRANSACTION = 7 // 6.3 measured (docs/adr/0004); a page reads the whole loan whatever its size, because the loan's Transactions are put in date order after they are found
  const SLACK = 30
  const OPENING_PER_TRANSACTION = 13 / 3 // 4.33 at the most for the opening balance (3, and 1.33 more for each Transaction before the start date), measured below and in docs/adr/0004

  beforeEach(async () => {
    // 4,000 Transactions of the household's other history, none in Alice's Category: they must cost nothing.
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 4000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT ?, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import', ?, CASE WHEN i % 2 = 0 THEN ? END FROM seq`,
    )
      .bind(parent, ids['Groceries'], ids['Fuel'])
      .run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${LOAN})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT CASE WHEN i % 2 = 0 THEN ? ELSE ? END, date('2022-01-01', '+' || i || ' days'), -100, 'EXAMPLE LOAN ' || i, 'import', ?, CASE WHEN i % 3 = 0 THEN ? END FROM seq`,
    )
      .bind(parent, child, ids[ALICE], ids['Fuel'])
      .run()
  })

  it('is two D1 queries for a page (the check that the Category is a Loans Category, and the page), and three with the opening balance of a start date on the first page', async () => {
    const plain = metered()
    expect((await requestWith(plain.db, { limit: '50' })).status).toBe(200)
    expect(plain.usage.queries).toBe(2)

    const dated = metered()
    expect((await requestWith(dated.db, { from: '2022-03-01', limit: '50' })).status).toBe(200)
    expect(dated.usage.queries).toBe(3)

    const later = metered()
    expect((await requestWith(later.db, { from: '2022-03-01', limit: '50', after: '2022-03-05:5000' })).status).toBe(200)
    expect(later.usage.queries).toBe(2) // the opening balance was on the first page
  })

  it('is one D1 query for a Category that is not a Loans Category, or does not exist: it asks, finds none, and stops', async () => {
    for (const categoryId of [String(ids['Groceries']), String(ids[ALICE] + 1000)]) {
      const { db, usage } = metered()
      expect((await requestWith(db, { categoryId })).status).toBe(404)
      expect(usage.queries).toBe(1)
      expect(usage.rowsRead).toBeLessThanOrEqual(5)
    }
  })

  it('reads the Category\'s own Transactions and none of the 4,000 around them: a page of the loan costs about the loan, not the history', async () => {
    const { db, usage } = metered()

    const res = await requestWith(db, { limit: '200' })

    const p = (await res.json()) as LoanPage
    expect(p.transactions).toHaveLength(200)
    expect(p.next).not.toBeNull()
    // Each of the loan's Transactions costs about six reads and a third: its index entry (found by the UNION of the two Category indexes, then merged), its row, its place in the
    // sort that puts the Category's Transactions in date order, its Account, its Override's Category and, on a third of them, its Rule's. The household's other 4,000 are not read at all.
    expect(usage.rowsRead).toBeLessThanOrEqual(LOAN * PER_TRANSACTION + SLACK)
    expect(usage.rowsRead).toBeGreaterThan(LOAN * 5) // so the allowance above is not slack for a cheaper plan
  })

  it('reads the same for a page late in the loan as for the first: every page finds the Category\'s Transactions again, which is why a loan\'s cost is its size times its pages', async () => {
    const first = metered()
    await requestWith(first.db, { limit: '100' })
    const late = metered()
    const res = await requestWith(late.db, { limit: '100', after: '2022-08-01:4200' })
    expect(res.status).toBe(200)
    expect(late.usage.rowsRead).toBeLessThanOrEqual(LOAN * PER_TRANSACTION + SLACK)
    expect(first.usage.rowsRead).toBeLessThanOrEqual(LOAN * PER_TRANSACTION + SLACK)
  })

  it('reads a family\'s loan in one request: a few hundred Transactions are a single page, with nothing to continue', async () => {
    const { db, usage } = metered()

    const res = await requestWith(db)

    const p = (await res.json()) as LoanPage
    expect(p.transactions).toHaveLength(LOAN)
    expect(p.next).toBeNull()
    expect(usage.queries).toBe(2)
    expect(usage.rowsRead).toBeLessThanOrEqual(LOAN * PER_TRANSACTION + SLACK)
  })

  it('pins what a loan of several pages costs in all: every page re-reads the whole loan, so three pages of a 2,400 Transaction loan cost three times one', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 2100)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT ?, date('2021-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE MORE ' || i, 'import', ?, CASE WHEN i % 3 = 0 THEN ? END FROM seq`,
    )
      .bind(parent, ids[ALICE], ids['Fuel'])
      .run()
    const size = LOAN + 2100
    let after: string | undefined
    const totals = { pages: 0, rows: 0, queries: 0, rowsRead: 0 }
    for (;;) {
      const { db, usage } = metered()
      const res = await requestWith(db, after ? { after } : {})
      const p = (await res.json()) as LoanPage
      totals.pages += 1
      totals.rows += p.transactions.length
      totals.queries += usage.queries
      totals.rowsRead += usage.rowsRead
      if (p.next === null) break
      after = p.next
    }

    expect(totals.pages).toBe(Math.ceil(size / LOANS_PAGE_SIZE))
    expect(totals.rows).toBe(size)
    expect(totals.queries).toBe(2 * totals.pages)
    // About 6.3 reads for each Transaction of the loan, for every page: not for the page's own thousand. The household's other 4,000 are never read.
    expect(totals.rowsRead).toBeLessThanOrEqual(totals.pages * (size * PER_TRANSACTION + SLACK))
    expect(totals.rowsRead).toBeGreaterThan(totals.pages * size * 4)
  })

  // The opening balance is its own statement (buildLoanOpening), metered here on its own. It finds the loan's Transactions as the page does (the two indexes' entries, then the
  // row: 3 reads for each of the loan's 300, every one of them, whatever the start date) and only for those before the start date reads the Override's Category and, on a third of
  // them, the Rule's: 1.3 more. So it is 3 reads for each Transaction of the loan, up to 4.3 for a start date after all of them, and there is no sort and no Account.
  it.each([
    ['no Transaction before the start date', '2000-01-01', 0, LOAN * 3],
    ['99 of them before the start date', '2022-04-11', 99, LOAN * 3 + 99 * (1 + 1 / 3)],
    ['all of them before the start date', '2100-01-01', LOAN, LOAN * OPENING_PER_TRANSACTION],
  ])('reads the whole loan again for the opening balance, whatever the start date, and none of the 4,000 around it: %s', async (_what, from, before, expected) => {
    const { sql, binds } = buildLoanOpening(ids[ALICE]!, from)
    const result = await env.DB.prepare(sql).bind(...binds).run<{ cents: number; count: number }>()
    expect(result.results).toEqual([{ cents: 0 - before * 100, count: before }])
    const reads = (result.meta as { rows_read: number }).rows_read
    expect(reads).toBeGreaterThanOrEqual(expected - 10)
    expect(reads).toBeLessThanOrEqual(expected + 10)
  })

  it('asks the first page of a loan with a start date for the opening balance as well, three queries, and a probe of one Transaction is that same page', async () => {
    const { db, usage } = metered()
    const res = await requestWith(db, { from: '2022-04-11', limit: '1' }) // a probe, as the Report asks for one when the cap has been reached
    const p = (await res.json()) as LoanPage
    expect(p.transactions).toHaveLength(1)
    expect(p.opening).toEqual({ cents: -99 * 100, count: 99 })
    expect(usage.queries).toBe(3)
    // The opening balance and the page each find the whole loan (a page of two rows sorts them without every row's Account, so it reads a little less than a full page does);
    // the 4,000 are not read.
    expect(usage.rowsRead).toBeLessThanOrEqual(LOAN * (OPENING_PER_TRANSACTION + PER_TRANSACTION) + SLACK)
    expect(usage.rowsRead).toBeGreaterThan(LOAN * 2 * 3)
  })
})
