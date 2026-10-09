import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { effectiveCategory } from './effective-category'

// Searching, filtering, sorting and paging the Transactions (the query for GET /api/transactions), as pure functions.
// The SQL is built here from constants chosen by validated input; a value from the request only ever reaches SQLite as a
// bound parameter (ADR 0005: plain SQL, no query builder).

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
/** Longest text searched for, so one request can't ask SQLite to match a pattern of any length. */
export const MAX_TEXT = 100

/** The columns a list can be sorted by. A sort never names a column from the request: it names one of these. */
export const SORT_KEYS = ['date', 'account', 'description', 'category', 'amount'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

const digits = z.optional(z.string().check(z.regex(/^\d{1,9}$/)))
const id = z.optional(z.string().check(z.regex(/^[1-9]\d{0,8}$/)))
const nzDate = z.optional(z.string().check(z.refine(isQueryDate)))

/** The query string of the list, validated before anything runs. A refusal names the field. */
export const searchQuery = z
  .object({
    accountId: id,
    categoryId: id,
    uncategorised: z.optional(z.literal('true')),
    from: nzDate,
    to: nzDate,
    text: z.optional(z.string().check(z.trim(), z.maxLength(MAX_TEXT))),
    sort: z.optional(z.enum(SORT_KEYS)),
    dir: z.optional(z.enum(['asc', 'desc'])),
    limit: digits,
    offset: digits,
  })
  .check(
    z.refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'] }),
    // A Transaction is either in a Category or Uncategorised, never both, so asking for both is a mistake worth naming.
    z.refine((q) => q.categoryId === undefined || q.uncategorised === undefined, { path: ['categoryId'] }),
  )

export type SearchQuery = z.output<typeof searchQuery>

export type Search = {
  accountId?: number
  categoryId?: number
  uncategorised: boolean
  /** NZ dates, both ends included. */
  from?: string
  to?: string
  /** Text to find in the description, bank memo or Note; `undefined` when blank. */
  text?: string
  sort: SortKey
  dir: SortDirection
  limit: number
  offset: number
}

/** A date sorts newest first unless asked otherwise, and everything else A to Z (or smallest first). */
const defaultDirection = (sort: SortKey): SortDirection => (sort === 'date' ? 'desc' : 'asc')

/** The validated query as a Search: defaults filled in and the page size capped. */
export function toSearch(q: SearchQuery): Search {
  const sort = q.sort ?? 'date'
  return {
    accountId: q.accountId === undefined ? undefined : Number(q.accountId),
    categoryId: q.categoryId === undefined ? undefined : Number(q.categoryId),
    uncategorised: q.uncategorised === 'true',
    from: q.from,
    to: q.to,
    text: q.text || undefined,
    sort,
    dir: q.dir ?? defaultDirection(sort),
    limit: Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset: Number(q.offset ?? 0),
  }
}

const ESCAPE = '\\'

/** A LIKE pattern that matches `text` anywhere, with `%`, `_` and the escape character itself taken literally. Pair it with `ESCAPE '\'`. */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => ESCAPE + c)}%`

export type Statement = { sql: string; binds: (string | number)[] }

/**
 * The two statements a list needs: how many Transactions match (`count`), and one page of them (`page`).
 * Only the filters asked for are in the SQL, so an index on the column can serve each one, and `count` joins only what its
 * filters read. A Transaction's Category is its effective Category (effective-category.ts), the same one the list shows.
 */
export function buildSearch(search: Search): { count: Statement; page: Statement } {
  const category = effectiveCategory()
  const where: string[] = []
  const binds: (string | number)[] = []
  if (search.accountId !== undefined) {
    where.push('t.account_id = ?')
    binds.push(search.accountId)
  }
  if (search.categoryId !== undefined) {
    where.push(`${category.id} = ?`)
    binds.push(search.categoryId)
  }
  if (search.uncategorised) where.push(`${category.id} IS NULL`)
  if (search.from !== undefined) {
    where.push('t.date >= ?')
    binds.push(search.from)
  }
  if (search.to !== undefined) {
    where.push('t.date <= ?')
    binds.push(search.to)
  }
  if (search.text !== undefined) {
    const pattern = likePattern(search.text)
    where.push(`(t.description LIKE ? ESCAPE '${ESCAPE}' OR t.bank_memo LIKE ? ESCAPE '${ESCAPE}' OR t.note LIKE ? ESCAPE '${ESCAPE}')`)
    binds.push(pattern, pattern, pattern)
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // The count joins only what its filters read: the Category's tables, and only when filtering by Category.
  const filterJoins = search.categoryId !== undefined || search.uncategorised ? category.joins : ''

  // Within equal values, newest first, so a page boundary never repeats or skips a Transaction.
  const direction = search.dir === 'asc' ? 'ASC' : 'DESC'
  const terms: Record<SortKey, string[]> = {
    date: ['t.date', 't.id'],
    account: ['a.name COLLATE NOCASE'],
    description: ['t.description COLLATE NOCASE'],
    // Uncategorised last when ascending.
    category: [`(${category.name} IS NULL)`, `${category.name} COLLATE NOCASE`],
    amount: ['t.amount_cents'],
  }
  const order = [...terms[search.sort].map((term) => `${term} ${direction}`), ...(search.sort === 'date' ? [] : ['t.date DESC', 't.id DESC'])].join(', ')

  return {
    count: { sql: `SELECT COUNT(*) AS total FROM transactions t ${filterJoins} ${filter}`, binds },
    page: {
      // Sorted by date (the default) the page is read off the date index and stops after `limit` rows. Any other sort, and any
      // text filter, reads every Transaction the other filters keep (ADR 0004: D1 bills rows read, so those are the dear requests).
      sql: `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents,
                   ${category.id} AS categoryId, ${category.name} AS categoryName, ${category.source} AS categorySource, t.note
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            ${filter}
            ORDER BY ${order} LIMIT ? OFFSET ?`,
      binds: [...binds, search.limit, search.offset],
    },
  }
}
