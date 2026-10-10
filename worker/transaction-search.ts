import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { CATEGORY_SLOTS, categoryColumns, effectiveCategory, type CategorySlot, type EffectiveCategory } from './effective-category'
import { PARTNER_JOIN } from './transfers'

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

/** The Transfers filter: only Transfers, or everything but them (the spending). The page offers the same ones (src/lib/transaction-search.ts). */
export const TRANSFERS_FILTERS = ['only', 'exclude'] as const
export type TransfersFilter = (typeof TRANSFERS_FILTERS)[number]

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
  // 'exclude' is the Transactions that count as spending: everything that is not a Transfer (effective-category.ts).
  transfers: z.optional(z.enum(TRANSFERS_FILTERS)),
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
  /** Only Transfers, or everything but: the spending. Unset is both. */
  transfers?: TransfersFilter
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

/** The validated filters of a query string as Filters: IDs read as numbers, blank text dropped. */
export const toFilters = (q: { accountId?: string; categoryId?: string; uncategorised?: 'true'; transfers?: TransfersFilter; from?: string; to?: string; text?: string }): Filters => ({
  accountId: q.accountId === undefined ? undefined : Number(q.accountId),
  categoryId: q.categoryId === undefined ? undefined : Number(q.categoryId),
  uncategorised: q.uncategorised === 'true',
  transfers: q.transfers,
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
 * The most Transactions a Category's indexes (one for each source that can supply a Category: an Override, a Rule, Akahu's) may list
 * for a page of it to be found through them. Reading a candidate costs about six reads (the index entry, the Transaction, its Account and
 * its Category lookups, and the sort), so 1,000 is at most about 6,000. Past it the date index finds a page sooner: it stops at the 50th
 * match, which for a Category holding 2% of 100,000 Transactions is about 2,500 rows, where the indexes would read 12,000 to list them all.
 */
export const CANDIDATE_LIMIT = 1000

/**
 * How many Transactions the indexes list for a Category, counted no further than CANDIDATE_LIMIT in each (so the probe reads at
 * most that many times the number of sources, however big the Category is). Compare with `isFewInCategory`. A Transaction in more
 * than one index counts for each.
 */
export const categoryProbe = (categoryId: number, slots: readonly CategorySlot[] = CATEGORY_SLOTS): Statement => {
  const columns = categoryColumns(slots)
  return {
    sql: `SELECT ${columns.map((column) => `(SELECT COUNT(*) FROM (SELECT 1 FROM transactions WHERE ${column} = ? LIMIT ${CANDIDATE_LIMIT + 1}))`).join(' + ')} AS candidates`,
    binds: columns.map(() => categoryId),
  }
}

export const isFewInCategory = (candidates: number) => candidates <= CANDIDATE_LIMIT

/** A date range is the one filter that makes the date index cheaper than the candidates for a Category with many: it reads the range and no more. (An Account's index is not selective: an Account holds a large share.) */
const narrowedByDate = (search: Search) => search.from !== undefined || search.to !== undefined

/**
 * Whether the way in is still to be chosen, so the probe should run before the statements are built. It is not when text is to be
 * found: a text search reads every Transaction it keeps, so it always goes in through the candidates, which are fewer (about 4.5 reads
 * each against about 1 for each Transaction scanned, so they are fewer while the Category holds under a fifth of them all). It is, when either
 * statement has a choice: a page sorted by date, which can walk the date index, or a count with a date range, which can read the
 * range. Any other page reads every Transaction it keeps whichever way it goes in, so it goes through the candidates.
 */
export const needsCategoryProbe = (search: Search) =>
  search.categoryId !== undefined && search.text === undefined && ((search.want !== 'count' && search.sort === 'date') || (search.want !== 'page' && narrowedByDate(search)))

/**
 * The conditions that pick the Transactions, to AND together after `FROM transactions t`, and the values to bind to them in order.
 * The one definition of what a filter means: the list, its count and the CSV export all build from it. Only the filters asked
 * for are in the SQL, so an index on the column can serve each one. A Transaction's Category is its effective Category
 * (effective-category.ts), the same one the list shows, so a query that filters by Category needs `category.joins`.
 * That is worked out per Transaction, through one join for each source that has a column (the Override, the Rule, and Akahu's
 * once Sync lands), and each join costs a row read on top (ADR 0004: D1 bills rows read). Taken alone these conditions read every
 * Transaction the other filters keep, which is what the CSV export does, since it wants them all. `buildSearch` adds the Category's
 * candidates to them (below) so that a list and its count read far fewer. A cached count, or a column kept up to date, is a later
 * ticket's call.
 * Whether a Transaction is a Transfer comes from the same definition (`category.isTransfer`, which needs `category.joins` too), so
 * the Transfers filter costs what the Category filter does. A Transfer is in no Category and is not Uncategorised: it is not
 * spending, so there is no Category to choose for it (`category.shown`).
 */
export function buildFilter(filters: Filters, category: EffectiveCategory = effectiveCategory()): { conditions: string[]; binds: (string | number)[] } {
  const conditions: string[] = []
  const binds: (string | number)[] = []
  if (filters.accountId !== undefined) {
    conditions.push('t.account_id = ?')
    binds.push(filters.accountId)
  }
  if (filters.categoryId !== undefined) {
    conditions.push(`${category.id} = ? AND NOT ${category.isTransfer}`)
    binds.push(filters.categoryId)
  }
  if (filters.uncategorised) conditions.push(`${category.id} IS NULL AND NOT ${category.isTransfer}`)
  if (filters.transfers !== undefined) conditions.push(filters.transfers === 'only' ? category.isTransfer : `NOT ${category.isTransfer}`)
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
 * `count` joins only what its filters read. The filters are `buildFilter`'s. The page also names the Account of a paired
 * Transaction's matching Transaction, two more reads for each paired row it touches and none for the rest.
 * A Transaction's Category is its effective Category (effective-category.ts), worked out per Transaction through a join for each
 * source, and each join costs a row read (ADR 0004: D1 bills rows read). A Category filter also names the candidates:
 * the Transactions the indexes on `override_category` and `rule_category` list for it (every Transaction in the Category is
 * one, whichever of the two supplies it), and the effective Category is then checked on those alone. That check stays, because a
 * candidate may be outranked (a Rule's Category under an Override to another one, or an Override of a removed Category), and so
 * does `AND NOT isTransfer`, which only takes Transactions away: the candidates are a superset of what the filter keeps.
 * - The count goes through the candidates: it reads about five rows for each one rather than all the Transactions. Unless the search
 *   has a date range and the Category has many (`fewInCategory` false): then it reads the range, which is fewer.
 * - A page does when the Category has few (`fewInCategory`, from the probe) or is sorted by anything but date, or has text to find,
 *   which read every Transaction they keep anyway. A page sorted by date of a Category with many walks the date index and stops at
 *   the 50th match, which is a few hundred reads where listing a big Category's candidates would be tens of thousands.
 * A Category filter that names an Account, dates, a Transfers filter or text keeps them too; the planner starts from the candidates.
 * The candidates come from `categoryColumns`, so a source that can supply a Category (Akahu's, when Sync lands) is among them as soon
 * as it has a slot with a column; each such column needs an index (the test says so).
 */
export function buildSearch(search: Search, slots: readonly CategorySlot[] = CATEGORY_SLOTS): { count: Statement; page: Statement } {
  const category = effectiveCategory(slots)
  const filter = buildFilter(search, category)
  // The Category's candidates: the Transactions its indexes list. The exact check in the filter stays with them.
  const columns = categoryColumns(slots)
  const candidates = search.categoryId === undefined ? null : { sql: `t.id IN (${columns.map((column) => `SELECT id FROM transactions WHERE ${column} = ?`).join(' UNION ')})`, binds: columns.map(() => search.categoryId!) }
  const whereOf = (withCandidates: boolean): Statement => {
    const through = withCandidates && candidates !== null
    const conditions = through ? [candidates.sql, ...filter.conditions] : filter.conditions
    return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', binds: through ? [...candidates.binds, ...filter.binds] : filter.binds }
  }
  const readsEverything = search.text !== undefined
  const counting = whereOf(readsEverything || search.fewInCategory === true || !narrowedByDate(search))
  const paging = whereOf(readsEverything || search.fewInCategory === true || search.sort !== 'date')
  // The count joins only what its filters read: the Category's tables, and only when filtering by Category or Transfer (the Override decides both).
  const filterJoins = search.categoryId !== undefined || search.uncategorised || search.transfers !== undefined ? category.joins : ''

  // Within equal values, newest first, so a page boundary never repeats or skips a Transaction.
  const direction = search.dir === 'asc' ? 'ASC' : 'DESC'
  const terms: Record<SortKey, string[]> = {
    date: ['t.date', 't.id'],
    account: ['a.name COLLATE NOCASE'],
    description: ['t.description COLLATE NOCASE'],
    // Uncategorised last when ascending, and Transfers, which have no Category to sort by, with them.
    category: [`(${category.shown.name} IS NULL)`, `${category.shown.name} COLLATE NOCASE`],
    amount: ['t.amount_cents'],
  }
  const order = [...terms[search.sort].map((term) => `${term} ${direction}`), ...(search.sort === 'date' ? [] : ['t.date DESC', 't.id DESC'])].join(', ')

  return {
    count: { sql: `SELECT COUNT(*) AS total FROM transactions t ${filterJoins} ${counting.sql}`, binds: counting.binds },
    page: {
      // Sorted by date (the default) the page is read off the date index and stops after `limit` rows. Any other sort, and any
      // text filter, reads every Transaction the other filters keep (ADR 0004: D1 bills rows read, so those are the dear requests).
      sql: `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents,
                   ${category.shown.id} AS categoryId, ${category.shown.name} AS categoryName, ${category.shown.source} AS categorySource, t.note,
                   ${category.transfer} AS transfer, partner_account.name AS transferAccountName
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            ${PARTNER_JOIN}
            ${paging.sql}
            ORDER BY ${order} LIMIT ? OFFSET ?`,
      binds: [...paging.binds, search.limit, search.offset],
    },
  }
}
