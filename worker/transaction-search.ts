import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { effectiveCategory } from './effective-category'
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

/** The query string of the list, validated before anything runs. A refusal names the field. */
export const searchQuery = z
  .object({
    accountId: id,
    categoryId: id,
    uncategorised: z.optional(z.literal('true')),
    // 'exclude' is the Transactions that count as spending: everything that is not a Transfer (effective-category.ts).
    transfers: z.optional(z.enum(TRANSFERS_FILTERS)),
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
  /** Uncategorised leaves out Transfers, which have no Category to give (effective-category.ts). */
  uncategorised: boolean
  /** Only Transfers, or everything but: the spending. Unset is both. */
  transfers?: TransfersFilter
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
    transfers: q.transfers,
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
 * The two statements a list needs: how many Transactions match (`count`), and one page of them (`page`).
 * Only the filters asked for are in the SQL, so an index on the column can serve each one, and `count` joins only what its
 * filters read. A Transaction's Category is its effective Category (effective-category.ts), the same one the list shows.
 * That is worked out per Transaction, through one join for each source that has a column (the Override, the Rule, and Akahu's
 * once Sync lands), and an Override's index cannot serve it once a Rule can also supply the Category. So a Category filter
 * or sort reads every Transaction the other filters keep, and each join costs a row read on top (ADR 0004: D1 bills rows
 * read). A cached count, or a column kept up to date, is a later ticket's call.
 * Whether a Transaction is a Transfer comes from the same definition (`category.isTransfer`), so the Transfers filter costs what the
 * Category filter does. The page also names the Account of a paired Transaction's matching Transaction, two more reads for each paired row it
 * touches and none for the rest.
 */
export function buildSearch(search: Search): { count: Statement; page: Statement } {
  const category = effectiveCategory()
  const where: string[] = []
  const binds: (string | number)[] = []
  if (search.accountId !== undefined) {
    where.push('t.account_id = ?')
    binds.push(search.accountId)
  }
  // A Transfer is in no Category, even when a Rule gave it one: it is not spending (`category.shown`).
  if (search.categoryId !== undefined) {
    where.push(`${category.id} = ? AND NOT ${category.isTransfer}`)
    binds.push(search.categoryId)
  }
  // A Transfer is not Uncategorised: it is not spending, so there is no Category to choose for it (it is a Transfer unless the Admin has chosen one).
  if (search.uncategorised) where.push(`${category.id} IS NULL AND NOT ${category.isTransfer}`)
  if (search.transfers !== undefined) where.push(search.transfers === 'only' ? category.isTransfer : `NOT ${category.isTransfer}`)
  if (search.from !== undefined) {
    where.push('t.date >= ?')
    binds.push(search.from)
  }
  if (search.to !== undefined) {
    where.push('t.date <= ?')
    binds.push(search.to)
  }
  if (search.text !== undefined) {
    // `instr`, not `LIKE`: D1 refuses a LIKE pattern over 50 bytes ("too complex") and the text can be 100 characters. `instr` also
    // takes `%`, `_` and `\` as the characters they are. `lower()` folds A to Z only, as COLLATE NOCASE does (as Rules do too).
    where.push(`(${TEXT_COLUMNS.map((column) => `instr(lower(${column}), lower(?)) > 0`).join(' OR ')})`)
    binds.push(...TEXT_COLUMNS.map(() => search.text!))
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
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
    count: { sql: `SELECT COUNT(*) AS total FROM transactions t ${filterJoins} ${filter}`, binds },
    page: {
      // Sorted by date (the default) the page is read off the date index and stops after `limit` rows. Any other sort, and any
      // text filter, reads every Transaction the other filters keep (ADR 0004: D1 bills rows read, so those are the dear requests).
      sql: `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents,
                   ${category.shown.id} AS categoryId, ${category.shown.name} AS categoryName, ${category.shown.source} AS categorySource, t.note,
                   ${category.transfer} AS transfer, partner_account.name AS transferAccountName
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            ${PARTNER_JOIN}
            ${filter}
            ORDER BY ${order} LIMIT ? OFFSET ?`,
      binds: [...binds, search.limit, search.offset],
    },
  }
}
