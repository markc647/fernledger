import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { effectiveCategory, type EffectiveCategory } from './effective-category'

// Searching, filtering, sorting and paging the Transactions (the query for GET /api/transactions), as pure functions.
// The SQL is built here from constants chosen by validated input; a value from the request only ever reaches SQLite as a
// bound parameter (ADR 0005: plain SQL, no query builder).

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
/** Longest text searched for, so one request can't ask SQLite to look for text of any length. The page keeps to the same length (src/lib/transaction-search.ts). */
export const MAX_TEXT = 100

/** The columns a list can be sorted by. A sort never names a column from the request: it names one of these. The page offers the same ones (src/lib/transaction-search.ts). */
export const SORT_KEYS = ['date', 'account', 'description', 'category', 'amount'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

const digits = z.optional(z.string().check(z.regex(/^\d{1,9}$/)))
const id = z.optional(z.string().check(z.regex(/^[1-9]\d{0,8}$/)))
const nzDate = z.optional(z.string().check(z.refine(isQueryDate)))

/**
 * The filters, as they come in a query string. The list and the CSV export both build their query string schema from these
 * and their SQL from `buildFilter`, so the export holds exactly the Transactions the list shows for the same filters.
 */
export const filterFields = {
  accountId: id,
  categoryId: id,
  uncategorised: z.optional(z.literal('true')),
  from: nzDate,
  to: nzDate,
  text: z.optional(z.string().check(z.trim(), z.maxLength(MAX_TEXT))),
}

/** What must hold across the filters. A refusal names the field in `path`. */
export const filterChecks = [
  z.refine<{ from?: string; to?: string }>((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'] }),
  // A Transaction is either in a Category or Uncategorised, never both, so asking for both is a mistake worth naming.
  z.refine<{ categoryId?: string; uncategorised?: 'true' }>((q) => q.categoryId === undefined || q.uncategorised === undefined, { path: ['categoryId'] }),
]

/** The query string of the list, validated before anything runs. A refusal names the field. */
export const searchQuery = z
  .object({
    ...filterFields,
    sort: z.optional(z.enum(SORT_KEYS)),
    dir: z.optional(z.enum(['asc', 'desc'])),
    limit: digits,
    offset: digits,
    count: z.optional(z.enum(['true', 'false', 'only'])),
  })
  .check(...filterChecks)

export type SearchQuery = z.output<typeof searchQuery>

/** What picks the Transactions: the same for the list and the export. */
export type Filters = {
  accountId?: number
  categoryId?: number
  uncategorised: boolean
  /** NZ dates, both ends included. */
  from?: string
  to?: string
  /** Text to find in the description, bank memo, Note or what the bank supplied about the payment; `undefined` when blank. */
  text?: string
}

export type Search = Filters & {
  sort: SortKey
  dir: SortDirection
  limit: number
  offset: number
  /** What to work out: the page of rows, how many Transactions match, or both. */
  want: Want
}

/** 'page' is the rows alone, 'count' only how many match, and 'both' the two. */
export type Want = 'page' | 'count' | 'both'

/**
 * Counting reads every Transaction the filters keep (ADR 0004: D1 bills rows read), so a request counts only when it asks to
 * (`count=true` or `count=only`) or is the first page, which is where a search starts. Later pages, and callers with no use for
 * a total (the Summary), don't count.
 */
const wantOf = (count: SearchQuery['count'], offset: number): Want =>
  count === 'only' ? 'count' : count === 'true' ? 'both' : count === 'false' ? 'page' : offset === 0 ? 'both' : 'page'

/** A date sorts newest first unless asked otherwise, and everything else A to Z (or smallest first). */
const defaultDirection = (sort: SortKey): SortDirection => (sort === 'date' ? 'desc' : 'asc')

/** The validated filters of a query string as Filters: IDs read as numbers, blank text dropped. */
export const toFilters = (q: { accountId?: string; categoryId?: string; uncategorised?: 'true'; from?: string; to?: string; text?: string }): Filters => ({
  accountId: q.accountId === undefined ? undefined : Number(q.accountId),
  categoryId: q.categoryId === undefined ? undefined : Number(q.categoryId),
  uncategorised: q.uncategorised === 'true',
  from: q.from,
  to: q.to,
  text: q.text || undefined,
})

/** The validated query as a Search: defaults filled in and the page size capped. */
export function toSearch(q: SearchQuery): Search {
  const sort = q.sort ?? 'date'
  const offset = Number(q.offset ?? 0)
  return {
    ...toFilters(q),
    sort,
    dir: q.dir ?? defaultDirection(sort),
    limit: Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset,
    want: wantOf(q.count, offset),
  }
}

/**
 * What a text search looks in: the description, the bank's memo, the Note, and what the bank supplied about the payment (its
 * reference, which is the cheque number for an Import, the counterparty's account, particulars, code and card suffix).
 * Interpolated into SQL, so constants written here and never anything from a request.
 */
const TEXT_COLUMNS = [
  't.description',
  't.bank_memo',
  't.note',
  't.bank_reference',
  't.bank_counterparty_account',
  't.bank_particulars',
  't.bank_payment_code',
  't.bank_card_suffix',
]

export type Statement = { sql: string; binds: (string | number)[] }

/**
 * The conditions that pick the Transactions, to AND together after `FROM transactions t`, and the values to bind to them in order.
 * The one definition of what a filter means: the list, its count and the CSV export all build from it. Only the filters asked
 * for are in the SQL, so an index on the column can serve each one. A Transaction's Category is its effective Category
 * (effective-category.ts), the same one the list shows, so a query that filters by Category needs `category.joins`.
 */
export function buildFilter(filters: Filters, category: EffectiveCategory = effectiveCategory()): { conditions: string[]; binds: (string | number)[] } {
  const conditions: string[] = []
  const binds: (string | number)[] = []
  if (filters.accountId !== undefined) {
    conditions.push('t.account_id = ?')
    binds.push(filters.accountId)
  }
  if (filters.categoryId !== undefined) {
    conditions.push(`${category.id} = ?`)
    binds.push(filters.categoryId)
  }
  if (filters.uncategorised) conditions.push(`${category.id} IS NULL`)
  if (filters.from !== undefined) {
    conditions.push('t.date >= ?')
    binds.push(filters.from)
  }
  if (filters.to !== undefined) {
    conditions.push('t.date <= ?')
    binds.push(filters.to)
  }
  if (filters.text !== undefined) {
    // `instr`, not `LIKE`: D1 refuses a LIKE pattern over 50 bytes ("too complex") and the text can be 100 characters. `instr` also
    // takes `%`, `_` and `\` as the characters they are. `lower()` folds A to Z only, as COLLATE NOCASE does (as Rules do too).
    conditions.push(`(${TEXT_COLUMNS.map((column) => `instr(lower(${column}), lower(?)) > 0`).join(' OR ')})`)
    binds.push(...TEXT_COLUMNS.map(() => filters.text!))
  }
  return { conditions, binds }
}

/**
 * The two statements a list needs: how many Transactions match (`count`), and one page of them (`page`).
 * `count` joins only what its filters read. The filters are `buildFilter`'s.
 */
export function buildSearch(search: Search): { count: Statement; page: Statement } {
  const category = effectiveCategory()
  const { conditions, binds } = buildFilter(search, category)
  const filter = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
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
