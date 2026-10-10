import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REPORT_PAGE_SIZE as PAGE_REPORT_PAGE_SIZE } from '../src/lib/report-transactions'
import { buildReportPage, REPORT_PAGE_SIZE, type ReportQuery } from './report-transactions'
import { MAX_LIMIT } from './transaction-search'

// Seam 1: the Transaction listing Report's data, through the Worker's exported handler as the local-development Admin or a
// read-only Member (the dev identity cookie is honoured on localhost only). Every Member can read it.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'
async function call(path: string, who: Who = 'member') {
  return exports.default.fetch(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))
}

type Row = {
  id: number
  date: string
  description: string
  amountCents: number
  categoryName: string | null
  note: string | null
  source: string
  bankReference: string | null
  bankCounterpartyAccount: string | null
  bankCardSuffix: string | null
  bankParticulars: string | null
  bankPaymentCode: string | null
}
type Page = { transactions: Row[]; next: string | null }

let savings = 0
let cheque = 0
const query = (over: Record<string, string> = {}) => new URLSearchParams({ accountId: String(savings), from: '2026-10-01', to: '2026-10-31', ...over }).toString()
const page = async (over: Record<string, string> = {}): Promise<Page> => {
  const res = await call(`/api/reports/transactions?${query(over)}`)
  expect(res.status, JSON.stringify(over)).toBe(200)
  return res.json()
}
const refusal = async (path: string) => {
  const res = await call(path)
  return { status: res.status, body: await res.json() }
}

type Added = { date?: string; amountCents?: number; description?: string; note?: string | null; overrideCategory?: number | null; ruleCategory?: number | null; accountId?: number }
let n = 0
/** Adds a made-up Transaction and returns its ID. Dated 1 October 2026 unless `date` says otherwise. */
async function add(t: Added = {}) {
  n += 1
  const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source, note, override_category, rule_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(t.accountId ?? savings, t.date ?? '2026-10-01', t.amountCents ?? -1000, t.description ?? `EXAMPLE SHOP ${n}`, 'import', t.note ?? null, t.overrideCategory ?? null, t.ruleCategory ?? null)
    .run()
  return meta.last_row_id
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  savings = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id").first<{ id: number }>())!.id
  cheque = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
  n = 0
})

/** What an Import has no more of: nothing the bank said about the payment. Neither of these is a Transfer. */
const bankless = { source: 'import', transfer: null, bankReference: null, bankCounterpartyAccount: null, bankCardSuffix: null, bankParticulars: null, bankPaymentCode: null }

describe('what a Report lists', () => {
  it('lists the Account\'s Transactions in the range, oldest first, with the Note and the effective Category', async () => {
    const groceries = starters[0]!
    const late = await add({ date: '2026-10-20', description: 'EXAMPLE LATE' })
    const early = await add({ date: '2026-10-02', description: 'EXAMPLE EARLY', note: 'Paid by cheque 123', overrideCategory: groceries.id })

    const { transactions, next } = await page()

    expect(transactions).toEqual([
      { ...bankless, id: early, date: '2026-10-02', description: 'EXAMPLE EARLY', amountCents: -1000, categoryName: groceries.name, note: 'Paid by cheque 123' },
      { ...bankless, id: late, date: '2026-10-20', description: 'EXAMPLE LATE', amountCents: -1000, categoryName: null, note: null },
    ])
    expect(next).toBeNull()
  })

  it('includes both ends of the range and leaves out what is outside it', async () => {
    await add({ date: '2026-09-30', description: 'EXAMPLE BEFORE' })
    await add({ date: '2026-10-01', description: 'EXAMPLE FIRST DAY' })
    await add({ date: '2026-10-31', description: 'EXAMPLE LAST DAY' })
    await add({ date: '2026-11-01', description: 'EXAMPLE AFTER' })

    expect((await page()).transactions.map((t) => t.description)).toEqual(['EXAMPLE FIRST DAY', 'EXAMPLE LAST DAY'])
  })

  it('lists one Account only', async () => {
    const mine = await add({ accountId: savings })
    await add({ accountId: cheque })

    expect((await page()).transactions.map((t) => t.id)).toEqual([mine])
    expect((await page({ accountId: String(cheque + 1000) })).transactions).toEqual([])
  })

  it('breaks a tie on date by ID, oldest first', async () => {
    const ids = [await add(), await add(), await add()]
    expect((await page()).transactions.map((t) => t.id)).toEqual(ids)
  })

  it('shows a removed Category as Uncategorised, as the Transactions list does', async () => {
    const gone = starters[0]!
    await add({ overrideCategory: gone.id })
    await env.DB.prepare('UPDATE categories SET removed_at = ? WHERE id = ?').bind('2026-10-05T00:00:00.000Z', gone.id).run()

    expect((await page()).transactions[0]!.categoryName).toBeNull()
  })

  it('shows the Category a Rule supplied, an Override over it, and a removed Rule Category as Uncategorised', async () => {
    const [byOverride, byRule] = starters
    await add({ description: 'EXAMPLE RULE ONLY', ruleCategory: byRule!.id })
    await add({ description: 'EXAMPLE BOTH', overrideCategory: byOverride!.id, ruleCategory: byRule!.id })
    await add({ description: 'EXAMPLE RULE REMOVED', ruleCategory: starters[2]!.id })
    await env.DB.prepare('UPDATE categories SET removed_at = ? WHERE id = ?').bind('2026-10-05T00:00:00.000Z', starters[2]!.id).run()

    expect((await page()).transactions.map((t) => [t.description, t.categoryName])).toEqual([
      ['EXAMPLE RULE ONLY', byRule!.name],
      ['EXAMPLE BOTH', byOverride!.name],
      ['EXAMPLE RULE REMOVED', null],
    ])
  })

  it('carries everything the bank said about each payment, for the record: reference or cheque number, counterparty account, card, particulars and code', async () => {
    const id = await add({ description: 'EXAMPLE SYNCED' })
    await env.DB.prepare(
      "UPDATE transactions SET source = 'sync', bank_reference = 'Ref 77', bank_counterparty_account = '99-9999-9999999-97', bank_card_suffix = '1234', bank_particulars = 'Rent', bank_payment_code = 'Oct' WHERE id = ?",
    )
      .bind(id)
      .run()

    expect((await page()).transactions[0]).toMatchObject({ source: 'sync', bankReference: 'Ref 77', bankCounterpartyAccount: '99-9999-9999999-97', bankCardSuffix: '1234', bankParticulars: 'Rent', bankPaymentCode: 'Oct' })
  })

  it('gives every Member the same Report as the Admin', async () => {
    await add({ note: 'A note' })
    const res = await call(`/api/reports/transactions?${query()}`, 'admin')
    expect(res.status).toBe(200)
    expect(((await res.json()) as Page).transactions).toEqual((await page()).transactions)
  })

  it('is closed to anyone who is not signed in', async () => {
    const res = await exports.default.fetch(new Request(`https://app.test/api/reports/transactions?${query()}`))
    expect(res.status).toBe(401)
  })
})

describe('paging', () => {
  it('pages through a range without repeating or skipping a Transaction, even inside one date', async () => {
    const ids = [
      await add({ date: '2026-10-01' }),
      await add({ date: '2026-10-02' }),
      await add({ date: '2026-10-02' }),
      await add({ date: '2026-10-02' }),
      await add({ date: '2026-10-03' }),
    ]

    const first = await page({ limit: '2' })
    expect(first.transactions.map((t) => t.id)).toEqual(ids.slice(0, 2))
    expect(first.next).toBe(`2026-10-02:${ids[1]}`)

    const second = await page({ limit: '2', after: first.next! })
    expect(second.transactions.map((t) => t.id)).toEqual(ids.slice(2, 4))

    const third = await page({ limit: '2', after: second.next! })
    expect(third.transactions.map((t) => t.id)).toEqual(ids.slice(4))
    expect(third.next).toBeNull()
  })

  it('has no next page when the page holds exactly what is left', async () => {
    await add()
    await add()
    const { transactions, next } = await page({ limit: '2' })
    expect(transactions).toHaveLength(2)
    expect(next).toBeNull()
  })

  it('keeps a page to the size asked for, at most REPORT_PAGE_SIZE (a request can\'t ask for a page too big for the CPU budget), and at least one', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${REPORT_PAGE_SIZE + 20})
       INSERT INTO transactions (account_id, date, amount_cents, description, source) SELECT ?, '2026-10-01', -100, 'EXAMPLE ' || i, 'import' FROM seq`,
    )
      .bind(savings)
      .run()
    expect((await page({ limit: '1' })).transactions).toHaveLength(1)
    expect((await page({ limit: '0' })).transactions).toHaveLength(1)
    const huge = await page({ limit: '100000' })
    expect(huge.transactions).toHaveLength(REPORT_PAGE_SIZE)
    expect(huge.next).not.toBeNull()
    expect((await page()).transactions).toHaveLength(REPORT_PAGE_SIZE) // and that is the page when none is asked for
  })

  it('uses the page size the Report page asks for (the page keeps its own copy), no bigger than the largest page of the Transactions list', () => {
    expect(PAGE_REPORT_PAGE_SIZE).toBe(REPORT_PAGE_SIZE)
    expect(REPORT_PAGE_SIZE).toBeLessThanOrEqual(MAX_LIMIT)
  })
})

describe('what a request refuses', () => {
  // Each is built when its test runs, once the Account exists.
  const without = (name: string) => () => {
    const params = new URLSearchParams(query())
    params.delete(name)
    return params.toString()
  }
  it.each([
    ['no Account', without('accountId'), 'accountId'],
    ['an Account that is not a number', () => query({ accountId: 'x' }), 'accountId'],
    ['an Account with a sign', () => query({ accountId: '-1' }), 'accountId'],
    ['no From date', without('from'), 'from'],
    ['no To date', without('to'), 'to'],
    ['a From date that is not a day', () => query({ from: '2026-02-30' }), 'from'],
    ['a To date outside the years accepted', () => query({ to: '2101-01-01' }), 'to'],
    ['a range that ends before it starts', () => query({ from: '2026-11-01', to: '2026-10-01' }), 'to'],
    ['a place to continue from that is not one', () => query({ after: 'soon' }), 'after'],
    ['a place to continue from with an impossible date', () => query({ after: '2026-13-01:5' }), 'after'],
    ['a place to continue from with a zero ID', () => query({ after: '2026-10-01:0' }), 'after'],
    ['a page size that is not a number', () => query({ limit: '-5' }), 'limit'],
  ])('refuses %s', async (_what, qs, field) => {
    const { status, body } = await refusal(`/api/reports/transactions?${qs()}`)
    expect(status).toBe(400)
    // The refusal names the field and never a value: values can be Transaction data.
    expect(body).toEqual({ error: 'Invalid request', field })
  })
})

describe('what a request reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day). A Report pages with a keyset (the date and ID to continue after),
  // not an offset, so every page costs about its own size however far into the history it is. A third of the Transactions
  // here have an Override and a third a Rule's Category, as a real history will, and each of those costs a read of its
  // Category (the effective Category joins both: effective-category.ts), so a row costs up to three reads, not one.
  const TRANSACTIONS = 6000
  const PAGE_READS = (REPORT_PAGE_SIZE + 1) * 3 + 10 // the page and one more, each with up to two Category lookups
  let accountId = 0
  beforeEach(async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT CASE WHEN i % 2 = 0 THEN ? ELSE ? END, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import',
              CASE WHEN i % 3 = 0 THEN ? END, CASE WHEN i % 3 = 1 THEN ? END FROM seq`,
    )
      .bind(savings, cheque, starters[0]!.id, starters[1]!.id)
      .run()
    accountId = savings
  })

  const reads = async (over: Partial<ReportQuery>) => {
    const { sql, binds } = buildReportPage({ accountId, from: '2020-01-01', to: '2100-12-31', limit: REPORT_PAGE_SIZE, ...over })
    const result = await env.DB.prepare(sql).bind(...binds).run()
    return { rows: result.results.length, read: (result.meta as { rows_read: number }).rows_read }
  }

  it('reads a page and one more to know whether there is another, not the whole history', async () => {
    const r = await reads({})
    expect(r.rows).toBe(REPORT_PAGE_SIZE + 1)
    expect(r.read).toBeLessThanOrEqual(PAGE_READS)
    expect(r.read).toBeGreaterThan((REPORT_PAGE_SIZE + 1) * 1.5) // the Category lookups are in the count, so the bound above means something
  })

  it('reads no more for a page deep in the history than for the first', async () => {
    const r = await reads({ after: { date: '2022-06-01', id: 4000 } })
    expect(r.rows).toBe(REPORT_PAGE_SIZE + 1)
    expect(r.read).toBeLessThanOrEqual(PAGE_READS)
  })

  it('reads only the dates asked for, in the Account asked for', async () => {
    const r = await reads({ from: '2021-03-01', to: '2021-03-31' })
    expect(r.rows).toBeGreaterThan(0)
    expect(r.read).toBeLessThanOrEqual(r.rows * 3 + 10)
  })
})
