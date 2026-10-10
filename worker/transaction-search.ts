import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { effectiveCategory } from './effective-category'

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
    count: z.optional(z.enum(['true', 'false', 'only'])),
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
  /** Text to find in the description, bank memo, Note or what the bank supplied about the payment; `undefined` when blank. */
  text?: string
  sort: SortKey
  dir: SortDirection
  limit: number
  offset: number
  /** What to work out: the page of rows, how many Transactions match, or both. */
  want: Want
  /**
   * Set by the caller from the Category probe (`categoryProbe`) when `needsCategoryProbe` says to run it: the Category has few enough
   * Transactions that the page is found through the Category's indexes. Left out, the page is found by walking the date index.
   */
  fewInCategory?: boolean
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

/** The validated query as a Search: defaults filled in and the page size capped. */
export function toSearch(q: SearchQuery): Search {
  const sort = q.sort ?? 'date'
  const offset = Number(q.offset ?? 0)
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
 * The most Transactions a Category's two indexes (an Override's and a Rule's) may list for a page of it to be found through them.
 * Reading a candidate costs about six reads (the index entry, the Transaction, its Account and its two Category lookups, and the
 * sort), so 1,000 is at most about 6,000. Past it the date index finds a page sooner: it stops at the 50th match, which for a Category
 * holding 2% of 100,000 Transactions is about 2,500 rows, where the indexes would read 12,000 to list them all.
 */
export const CANDIDATE_LIMIT = 1000

/**
 * How many Transactions the indexes list for a Category, counted no further than CANDIDATE_LIMIT in each (so the probe reads at
 * most twice that, however big the Category is). Compare with `isFewInCategory`. A Transaction in both indexes counts twice.
 */
export const categoryProbe = (categoryId: number): Statement => ({
  sql: `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM transactions WHERE override_category = ?1 LIMIT ${CANDIDATE_LIMIT + 1}))
             + (SELECT COUNT(*) FROM (SELECT 1 FROM transactions WHERE rule_category = ?1 LIMIT ${CANDIDATE_LIMIT + 1})) AS candidates`,
  binds: [categoryId],
})

export const isFewInCategory = (candidates: number) => candidates <= CANDIDATE_LIMIT

/** Whether to run the probe before building the statements: only a page sorted by date can be found either way. Any other page reads every Transaction it keeps, so it always uses the indexes. */
export const needsCategoryProbe = (search: Search) => search.categoryId !== undefined && search.want !== 'count' && search.sort === 'date'

/**
 * The two statements a list needs: how many Transactions match (`count`), and one page of them (`page`).
 * Only the filters asked for are in the SQL, so an index on the column can serve each one, and `count` joins only what its
 * filters read. A Transaction's Category is its effective Category (effective-category.ts), the same one the list shows.
 * That is worked out per Transaction, through one join for each source that has a column (the Override, the Rule, and Akahu's
 * once Sync lands), and each join costs a row read (ADR 0004: D1 bills rows read). A Category filter also names the candidates:
 * the Transactions the indexes on `override_category` and `rule_category` list for it (every Transaction in the Category is
 * one, whichever of the two supplies it), and the effective Category is then checked on those alone. That check stays, because a
 * candidate may be outranked (a Rule's Category under an Override to another one, or an Override of a removed Category).
 * - The count always goes through the candidates: it reads about five rows for each one rather than all the Transactions.
 * - A page does when the Category has few (`fewInCategory`, from the probe) or is sorted by anything but date, which reads every
 *   Transaction it keeps anyway. A page sorted by date of a Category with many walks the date index and stops at the 50th match,
 *   which is a few hundred reads where listing a big Category's candidates would be tens of thousands.
 * A Category filter that names an Account, dates or text keeps them too; the planner starts from the candidates.
 * A cached count, or a column kept up to date, is a later ticket's call.
 */
export function buildSearch(search: Search): { count: Statement; page: Statement } {
  const category = effectiveCategory()
  const where: Statement[] = []
  const add = (sql: string, ...binds: (string | number)[]) => where.push({ sql, binds })
  if (search.accountId !== undefined) add('t.account_id = ?', search.accountId)
  if (search.categoryId !== undefined) add(`${category.id} = ?`, search.categoryId)
  if (search.uncategorised) add(`${category.id} IS NULL`)
  if (search.from !== undefined) add('t.date >= ?', search.from)
  if (search.to !== undefined) add('t.date <= ?', search.to)
  if (search.text !== undefined) {
    // `instr`, not `LIKE`: D1 refuses a LIKE pattern over 50 bytes ("too complex") and the text can be 100 characters. `instr` also
    // takes `%`, `_` and `\` as the characters they are. `lower()` folds A to Z only, as COLLATE NOCASE does (as Rules do too).
    add(`(${TEXT_COLUMNS.map((column) => `instr(lower(${column}), lower(?)) > 0`).join(' OR ')})`, ...TEXT_COLUMNS.map(() => search.text!))
  }
  // The Category's candidates: the Transactions its two indexes list. The exact check above stays with them.
  const candidates: Statement[] =
    search.categoryId === undefined
      ? []
      : [{ sql: 't.id IN (SELECT id FROM transactions WHERE override_category = ? UNION SELECT id FROM transactions WHERE rule_category = ?)', binds: [search.categoryId, search.categoryId] }]
  const filterOf = (conditions: Statement[]) => ({ sql: conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '', binds: conditions.flatMap((c) => c.binds) })
  const counting = filterOf([...candidates, ...where])
  const paging = filterOf(search.fewInCategory === true || search.sort !== 'date' ? [...candidates, ...where] : where)
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
    count: { sql: `SELECT COUNT(*) AS total FROM transactions t ${filterJoins} ${counting.sql}`, binds: counting.binds },
    page: {
      // Sorted by date (the default) the page is read off the date index and stops after `limit` rows. Any other sort, and any
      // text filter, reads every Transaction the other filters keep (ADR 0004: D1 bills rows read, so those are the dear requests).
      sql: `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents,
                   ${category.id} AS categoryId, ${category.name} AS categoryName, ${category.source} AS categorySource, t.note
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            ${paging.sql}
            ORDER BY ${order} LIMIT ? OFFSET ?`,
      binds: [...paging.binds, search.limit, search.offset],
    },
  }
}
