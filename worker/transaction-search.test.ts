import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { MAX_TEXT as PAGE_MAX_TEXT, SORT_KEYS as PAGE_SORT_KEYS } from '../src/lib/transaction-search'
import { effectiveCategory } from './effective-category'
import { buildSearch, CANDIDATE_LIMIT, categoryProbe, isFewInCategory, MAX_LIMIT, MAX_TEXT, needsCategoryProbe, searchQuery, SORT_KEYS, toSearch, type Search } from './transaction-search'

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
  /** What the Worker does for a request: the Category probe when the search needs one, then the count and the page. */
  const planned = async (over: Partial<Search>) => {
    let s = search(over)
    if (needsCategoryProbe(s)) {
      const probe = categoryProbe(s.categoryId!)
      const { candidates } = (await env.DB.prepare(probe.sql).bind(...probe.binds).first<{ candidates: number }>())!
      s = { ...s, fewInCategory: isFewInCategory(candidates) }
    }
    return s
  }
  const reads = async (over: Partial<Search>) => {
    const { count, page } = buildSearch(await planned(over))
    const [c, p] = await env.DB.batch([env.DB.prepare(count.sql).bind(...count.binds), env.DB.prepare(page.sql).bind(...page.binds)])
    return {
      total: (c!.results[0] as { total: number }).total,
      count: (c!.meta as { rows_read: number }).rows_read,
      page: (p!.meta as { rows_read: number }).rows_read,
      ids: (p!.results as { id: number }[]).map((r) => r.id),
    }
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

  // A Transaction's Category is its Override or else its Rule's, so a Category filter checks the effective Category of each Transaction
  // it considers. Which it considers is the question (transaction-search.ts): the Transactions the Category's two indexes list, or all
  // of them. Whichever it reads, it must find exactly the Transactions whose effective Category it is.
  describe('a Category', () => {
    // Category 1 has few Transactions, found by its Rule and by an Override. Category 2 has a fifth of them. Category 3 is what an
    // Override outranking the Rule gives two of Category 1's, and a removed Category's Override counts for nothing. Put back after,
    // so the other tests still see Transactions with no Category.
    beforeAll(async () => {
      const gone = (await env.DB.prepare("INSERT INTO categories (name, removed_at) VALUES ('Search test removed', '2026-10-01T00:00:00.000Z') RETURNING id").first<{ id: number }>())!.id
      await env.DB.batch([
        env.DB.prepare('UPDATE transactions SET rule_category = 1 WHERE id % 600 = 0'),
        env.DB.prepare('UPDATE transactions SET override_category = 1 WHERE id % 1500 = 0'),
        env.DB.prepare('UPDATE transactions SET rule_category = 2 WHERE id % 5 = 0 AND rule_category IS NULL'),
        env.DB.prepare('UPDATE transactions SET override_category = 3 WHERE id IN (600, 1200)'),
        env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = 1800').bind(gone),
      ])
    })
    afterAll(async () => {
      await env.DB.prepare('UPDATE transactions SET rule_category = NULL, override_category = NULL').run()
    })

    const effective = async (categoryId: number) => {
      const category = effectiveCategory()
      const { results } = await env.DB.prepare(`SELECT t.id FROM transactions t ${category.joins} WHERE ${category.id} = ? ORDER BY t.date DESC, t.id DESC`).bind(categoryId).all<{ id: number }>()
      return results.map((r) => r.id)
    }
    const byId = (ids: number[]) => ids.slice().sort((a, b) => a - b)

    it("is found by its Override or by its Rule, unless an Override to another Category outranks the Rule, and a removed Category's Override counts for nothing", async () => {
      const expected = await effective(1)
      // The Rule's: 600 to 6000 by 600, but not 600 and 1200 (Overridden to Category 3); 1800 stays (its Override is of a removed Category).
      // The Override's: 1500 to 6000 by 1500. 3000 and 6000 are both.
      expect(byId(expected)).toEqual([1500, 1800, 2400, 3000, 3600, 4200, 4500, 4800, 5400, 6000])

      for (const over of [{ categoryId: 1 }, { categoryId: 1, sort: 'amount' as const, dir: 'asc' as const }]) {
        const r = await reads({ ...over, limit: 200 })
        expect(r.total, JSON.stringify(over)).toBe(expected.length)
        expect(byId(r.ids), JSON.stringify(over)).toEqual(byId(expected))
      }
      // A Category with many is the same page whichever way it is found.
      const many = await effective(2)
      for (const fewInCategory of [true, false]) {
        const { page } = buildSearch(search({ categoryId: 2, limit: 200, fewInCategory }))
        const ids = ((await env.DB.prepare(page.sql).bind(...page.binds).all()).results as { id: number }[]).map((r) => r.id)
        expect(ids, `fewInCategory ${fewInCategory}`).toEqual(many.slice(0, 200))
      }
    })

    it('with few Transactions is found through its indexes: a page reads about what is in it, not what there is', async () => {
      const r = await reads({ categoryId: 1 })
      expect(r.total).toBe(10)
      expect(r.count).toBeLessThanOrEqual(100)
      expect(r.page).toBeLessThanOrEqual(150) // the 10 in it, each with its Account and Categories, and the sort of them
      expect((await reads({ categoryId: 1, sort: 'amount' })).page).toBeLessThanOrEqual(150) // any other sort too
    })

    it("with many is counted through its indexes and paged off the date index, which stops at the page's 50th", async () => {
      const r = await reads({ categoryId: 2 })
      expect(r.total).toBe((await effective(2)).length)
      expect(r.total).toBeGreaterThan(CANDIDATE_LIMIT)
      expect(r.count).toBeLessThanOrEqual(r.total * 5 + 20) // an index entry, the Transaction and its two Category lookups
      expect(r.page).toBeLessThanOrEqual(1000) // every fifth is in it: about 250 are read to find 50
    })

    it('is told apart as few or many by a probe that reads no further than CANDIDATE_LIMIT in each index', async () => {
      const probed = async (categoryId: number) => {
        const probe = categoryProbe(categoryId)
        const result = await env.DB.prepare(probe.sql).bind(...probe.binds).all<{ candidates: number }>()
        return { candidates: result.results[0]!.candidates, rowsRead: (result.meta as { rows_read: number }).rows_read }
      }
      const few = await probed(1)
      const many = await probed(2)

      expect(few.candidates).toBeLessThanOrEqual(CANDIDATE_LIMIT)
      expect(isFewInCategory(few.candidates)).toBe(true)
      expect(few.rowsRead).toBeLessThanOrEqual(few.candidates + 10)
      expect(many.candidates).toBeGreaterThan(CANDIDATE_LIMIT) // 1,200 are in it: the probe stops counting at the limit, so it never reads a big Category through
      expect(isFewInCategory(many.candidates)).toBe(false)
      expect(many.rowsRead).toBeLessThanOrEqual(2 * (CANDIDATE_LIMIT + 1) + 10)
    })

    it('needs the probe only for a page sorted by date', () => {
      expect(needsCategoryProbe(search({ categoryId: 1 }))).toBe(true)
      expect(needsCategoryProbe(search({ categoryId: 1, sort: 'amount' }))).toBe(false) // it reads every Transaction it keeps, so the fewest is best
      expect(needsCategoryProbe(search({ categoryId: 1, want: 'count' }))).toBe(false)
      expect(needsCategoryProbe(search({}))).toBe(false)
    })
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
