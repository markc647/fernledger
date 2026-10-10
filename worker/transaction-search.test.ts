import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { EXPORT_MAX_ROWS as PAGE_EXPORT_MAX_ROWS, MAX_TEXT as PAGE_MAX_TEXT, SORT_KEYS as PAGE_SORT_KEYS } from '../src/lib/transaction-search'
import { EXPORT_MAX_ROWS } from './transaction-export'
import { buildSearch, MAX_LIMIT, MAX_TEXT, searchQuery, SORT_KEYS, toSearch, type Search } from './transaction-search'

const search = (over: Partial<Search> = {}): Search => ({ uncategorised: false, sort: 'date', dir: 'desc', limit: 50, offset: 0, want: 'both', ...over })
const parse = (query: Record<string, string | string[]>) => toSearch(z.parse(searchQuery, query))

describe('toSearch', () => {
  it('fills in the defaults: everything, newest first, 50 at a time, with the total', () => {
    expect(parse({})).toEqual({ accountId: undefined, categoryId: undefined, uncategorised: false, from: undefined, to: undefined, text: undefined, sort: 'date', dir: 'desc', limit: 50, offset: 0, want: 'both' })
  })

  it('sorts every column but date A to Z (smallest first) unless told otherwise', () => {
    for (const sort of SORT_KEYS) expect(parse({ sort }).dir).toBe(sort === 'date' ? 'desc' : 'asc')
    expect(parse({ sort: 'description', dir: 'desc' }).dir).toBe('desc')
  })

  it('caps the page size and never goes below one', () => {
    expect(parse({ limit: '100000' }).limit).toBe(MAX_LIMIT)
    expect(parse({ limit: '0' }).limit).toBe(1)
  })

  it('reads blank text as no text', () => {
    expect(parse({ text: '   ' }).text).toBeUndefined()
  })

  it('counts on the first page and not on later ones, unless told', () => {
    expect(parse({ offset: '0' }).want).toBe('both')
    expect(parse({ offset: '50' }).want).toBe('page')
    expect(parse({ offset: '50', count: 'true' }).want).toBe('both')
    expect(parse({ count: 'false' }).want).toBe('page')
    expect(parse({ count: 'only', offset: '50' }).want).toBe('count')
  })
})

describe('the Transactions page', () => {
  // The page keeps its own copies (it can't import Worker code), so this is what stops them drifting apart.
  it('offers exactly the sorts the API accepts', () => {
    expect([...PAGE_SORT_KEYS]).toEqual([...SORT_KEYS])
  })

  it('tells the reader the most a CSV export holds', () => {
    expect(PAGE_EXPORT_MAX_ROWS).toBe(EXPORT_MAX_ROWS)
  })

  it('stops typing at the length of text the API accepts', () => {
    expect(PAGE_MAX_TEXT).toBe(MAX_TEXT)
    expect(z.safeParse(searchQuery, { text: 'x'.repeat(PAGE_MAX_TEXT) }).success).toBe(true)
    expect(z.safeParse(searchQuery, { text: 'x'.repeat(PAGE_MAX_TEXT + 1) }).success).toBe(false)
  })
})

describe('what a request reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day), so the filters that have an index must use it, and a request that
  // reads every Transaction is the dear one. A month of 6,000 Transactions in two Accounts costs a few hundred reads, not 6,000.
  const TRANSACTIONS = 6000
  let accountId = 0
  beforeAll(async () => {
    await env.DB.batch(['transactions', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
    const ids = (
      await env.DB.batch([
        env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id"),
        env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Example cheque') RETURNING id"),
      ])
    ).map((r) => (r.results[0] as { id: number }).id)
    accountId = ids[0]!
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO transactions (account_id, date, amount_cents, description, source) 
       SELECT CASE WHEN i % 2 = 0 THEN ? ELSE ? END, date('2020-01-01', '+' || (i / 4) || ' days'), -100, CASE WHEN i % 10 = 0 THEN 'EXAMPLE CAFE ' ELSE 'EXAMPLE ' END || i, 'import' FROM seq`,
    )
      .bind(ids[0], ids[1])
      .run()
  })

  const reads = async (over: Partial<Search>) => {
    const { count, page } = buildSearch(search(over))
    const [c, p] = await env.DB.batch([env.DB.prepare(count.sql).bind(...count.binds), env.DB.prepare(page.sql).bind(...page.binds)])
    return { total: (c!.results[0] as { total: number }).total, count: (c!.meta as { rows_read: number }).rows_read, page: (p!.meta as { rows_read: number }).rows_read }
  }

  it('reads one page off the date index for the default list', async () => {
    expect((await reads({})).page).toBeLessThanOrEqual(150)
  })

  it('reads each Transaction once to count them', async () => {
    const r = await reads({})
    expect(r.total).toBe(TRANSACTIONS)
    expect(r.count).toBeLessThanOrEqual(TRANSACTIONS + 10)
  })

  it('reads only the dates asked for when there is a date range, with or without an Account', async () => {
    for (const over of [{}, { accountId }]) {
      const r = await reads({ ...over, from: '2021-03-01', to: '2021-03-31' })
      expect(r.total).toBeGreaterThan(0)
      expect(r.count).toBeLessThanOrEqual(r.total * 2 + 10)
      expect(r.page).toBeLessThanOrEqual(r.total * 2 + 150)
    }
  })

  it('reads next to nothing to count and list one Category (its Overrides have an index)', async () => {
    const r = await reads({ categoryId: 1 })
    expect(r.count).toBeLessThanOrEqual(10)
    expect(r.page).toBeLessThanOrEqual(10)
  })

  it('reads each Transaction once to count the Uncategorised ones, and a page of them off the date index', async () => {
    const r = await reads({ uncategorised: true })
    expect(r.total).toBe(TRANSACTIONS)
    expect(r.count).toBeLessThanOrEqual(TRANSACTIONS + 10)
    expect(r.page).toBeLessThanOrEqual(150)
  })

  it('reads every Transaction to count a text search, but a page of it, newest first, only as far as its 50th match', async () => {
    const r = await reads({ text: 'cafe' })
    expect(r.total).toBe(TRANSACTIONS / 10)
    expect(r.count).toBeLessThanOrEqual(TRANSACTIONS + 10)
    expect(r.page).toBeLessThanOrEqual(1000) // every tenth is a match, so about 500 are read to find 50
  })

  // The dear request: the whole table is read, looked up in Accounts and sorted. ADR 0004 gives the budget this spends.
  it('reads about three times every Transaction to sort a page by any column but date', async () => {
    const r = await reads({ sort: 'amount' })
    expect(r.page).toBeLessThanOrEqual(TRANSACTIONS * 3 + 10)
    const text = await reads({ text: 'cafe', sort: 'amount' })
    expect(text.page).toBeLessThanOrEqual(TRANSACTIONS + text.total * 2 + 10) // the scan, then only what matched
  })
})
