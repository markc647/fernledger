import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { buildSearch, likePattern, MAX_LIMIT, searchQuery, SORT_KEYS, toSearch, type Search } from './transaction-search'

const search = (over: Partial<Search> = {}): Search => ({ uncategorised: false, sort: 'date', dir: 'desc', limit: 50, offset: 0, ...over })
const parse = (query: Record<string, string | string[]>) => toSearch(z.parse(searchQuery, query))

describe('likePattern', () => {
  it('finds the text anywhere', () => {
    expect(likePattern('cafe')).toBe('%cafe%')
  })

  it.each([
    ['%', '%\\%%'],
    ['_', '%\\_%'],
    ['\\', '%\\\\%'],
    ['100%_\\', '%100\\%\\_\\\\%'],
  ])('escapes %s so it is taken literally', (text, pattern) => {
    expect(likePattern(text)).toBe(pattern)
  })
})

describe('toSearch', () => {
  it('fills in the defaults: everything, newest first, 50 at a time', () => {
    expect(parse({})).toEqual({ accountId: undefined, categoryId: undefined, uncategorised: false, from: undefined, to: undefined, text: undefined, sort: 'date', dir: 'desc', limit: 50, offset: 0 })
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
})

describe('buildSearch', () => {
  it('has no WHERE when nothing is filtered, and counts without joining anything', () => {
    const { count, page } = buildSearch(search())
    expect(count).toEqual({ sql: expect.not.stringContaining('WHERE'), binds: [] })
    expect(count.sql).not.toContain('JOIN')
    expect(page.sql).not.toContain('WHERE')
    expect(page.binds).toEqual([50, 0])
  })

  it('binds every value from the request and writes none of them into the SQL', () => {
    const hostile = "x'; DROP TABLE transactions; --"
    const { count, page } = buildSearch(search({ accountId: 7, categoryId: 9, from: '2026-01-01', to: '2026-02-01', text: hostile }))

    for (const sql of [count.sql, page.sql]) {
      expect(sql).not.toContain('DROP')
      expect(sql).not.toContain('2026')
      expect(sql.match(/\?/g)).toHaveLength(sql === count.sql ? count.binds.length : page.binds.length)
    }
    expect(count.binds).toEqual([7, 9, '2026-01-01', '2026-02-01', likePattern(hostile), likePattern(hostile), likePattern(hostile)])
    expect(page.binds).toEqual([...count.binds, 50, 0])
  })

  it('searches the description, the bank memo and the Note, with the escape character declared', () => {
    const { count } = buildSearch(search({ text: 'cafe' }))
    expect(count.sql).toContain("t.description LIKE ? ESCAPE '\\'")
    expect(count.sql).toContain("t.bank_memo LIKE ? ESCAPE '\\'")
    expect(count.sql).toContain("t.note LIKE ? ESCAPE '\\'")
  })

  it('joins the Category only to count by Category', () => {
    expect(buildSearch(search({ accountId: 1 })).count.sql).not.toContain('JOIN')
    expect(buildSearch(search({ categoryId: 1 })).count.sql).toContain('LEFT JOIN categories')
    expect(buildSearch(search({ uncategorised: true })).count.sql).toContain('LEFT JOIN categories')
  })

  // Each sort is one of these fixed expressions, and ends on the date and ID so a page boundary never repeats or skips a Transaction.
  it.each([
    ['date', 'desc', 't.date DESC, t.id DESC'],
    ['date', 'asc', 't.date ASC, t.id ASC'],
    ['description', 'asc', 't.description COLLATE NOCASE ASC, t.date DESC, t.id DESC'],
    ['amount', 'desc', 't.amount_cents DESC, t.date DESC, t.id DESC'],
    ['account', 'asc', 'a.name COLLATE NOCASE ASC, t.date DESC, t.id DESC'],
    ['category', 'asc', '(category_override.name IS NULL) ASC, category_override.name COLLATE NOCASE ASC, t.date DESC, t.id DESC'],
    ['category', 'desc', '(category_override.name IS NULL) DESC, category_override.name COLLATE NOCASE DESC, t.date DESC, t.id DESC'],
  ] as const)('orders sort=%s dir=%s by %s', (sort, dir, order) => {
    expect(buildSearch(search({ sort, dir })).page.sql).toContain(`ORDER BY ${order} LIMIT ? OFFSET ?`)
  })

  it('has an order for every sort the API accepts', () => {
    for (const sort of SORT_KEYS) expect(buildSearch(search({ sort })).page.sql, sort).toMatch(/ORDER BY \S.* LIMIT/s)
  })
})

describe('what a request reads from D1', () => {
  // ADR 0004: D1 Free bills rows read, so the filters that have an index must use it. A month of 6,000 Transactions in
  // two Accounts costs a few hundred reads, not 6,000.
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
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 6000)
       INSERT INTO transactions (account_id, date, amount_cents, description, source)
       SELECT CASE WHEN i % 2 = 0 THEN ? ELSE ? END, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ' || i, 'import' FROM seq`,
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
})
