import { addressId, searchDate } from './report-transactions'

// What the Transactions page keeps in its address (the Export page keeps its filters, `parseExportSearch`), so a search survives a reload and Back returns to it. The API's own
// parameters are built from it by `apiQuery`. Everything here is forgiving: an address typed or edited by hand never breaks the page.

/** The sorts the API accepts (worker/transaction-search.test.ts pins the two lists together). */
export const SORT_KEYS = ['date', 'account', 'description', 'category', 'amount'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

/** What the API's `transfers` filter accepts (worker/transaction-search.ts). */
export const TRANSFERS_FILTERS = ['only', 'exclude'] as const
export type TransfersFilter = (typeof TRANSFERS_FILTERS)[number]

/** The longest text the API searches for (worker/transaction-search.test.ts pins the two together). */
export const MAX_TEXT = 100
/** The last page the address accepts: 100,000 pages of 50 is 5 million Transactions, far past any history the app is built for. */
const MAX_PAGE = 100_000

export type TransactionSearch = {
  /** An Account's ID; 0 when the address names one that isn't an ID (`addressId`), so the page says there is no such Account. */
  account?: number
  /** A Category's ID (0 as for `account`), or 'uncategorised' for those with none. */
  category?: number | 'uncategorised'
  /** Only Transfers, or everything but (the spending). Left out for both. */
  transfers?: TransfersFilter
  /** NZ dates, YYYY-MM-DD, both ends included. */
  from?: string
  to?: string
  /** Text to find in the description, bank memo, Note, or what the bank supplied about the payment. */
  q?: string
  sort?: SortKey
  dir?: SortDirection
  /** From 1; left out for the first page. */
  page?: number
}

/** Where a Transaction's details were opened from, when it was not the Transactions page: Back returns there. */
export type DetailOrigin = 'uncategorised'

/** A date sorts newest first and everything else A to Z (or smallest first), unless the address says otherwise. */
export const defaultDirection = (sort: SortKey): SortDirection => (sort === 'date' ? 'desc' : 'asc')

export const sortOf = (search: Pick<TransactionSearch, 'sort' | 'dir'>): { sort: SortKey; dir: SortDirection } => {
  const sort = search.sort ?? 'date'
  return { sort, dir: search.dir ?? defaultDirection(sort) }
}

/**
 * The search with what is empty or already the default left out, so the address stays short. Each is `undefined`, and not missing, because the router lays what a route
 * validates over the address's own search, so a missing key would leave the address's text in its place.
 */
export function tidy(search: TransactionSearch): TransactionSearch {
  const { sort, dir } = sortOf(search)
  return {
    account: search.account,
    category: search.category,
    transfers: search.transfers,
    from: search.from || undefined,
    to: search.to || undefined,
    q: search.q || undefined,
    sort: sort === 'date' ? undefined : sort,
    dir: dir === defaultDirection(sort) ? undefined : dir,
    page: search.page && search.page > 1 ? search.page : undefined,
  }
}

const positiveInteger = (value: unknown, max: number) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : undefined
}

/**
 * Reads the address's search parameters, which the router has already parsed (so `?q=2026` arrives as a number and `?account=2`
 * as 2), into a TransactionSearch. Anything that isn't valid is left out rather than refused, except an Account or Category that is named but isn't an ID,
 * which is one that does not exist (`addressId`).
 */
export function parseTransactionSearch(raw: Record<string, unknown>): TransactionSearch {
  const text = typeof raw.q === 'string' || typeof raw.q === 'number' || typeof raw.q === 'boolean' ? String(raw.q).trim().slice(0, MAX_TEXT) : ''
  return tidy({
    account: addressId(raw.account),
    category: raw.category === 'uncategorised' ? 'uncategorised' : addressId(raw.category),
    transfers: TRANSFERS_FILTERS.find((filter) => filter === raw.transfers),
    from: searchDate(raw.from),
    to: searchDate(raw.to),
    q: text,
    sort: SORT_KEYS.find((key) => key === raw.sort),
    dir: raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : undefined,
    page: positiveInteger(raw.page, MAX_PAGE),
  })
}

type Listed = readonly { id: number }[] | undefined

/**
 * What the search names that doesn't exist, if anything: an Account or Category of 0 (an address naming one that isn't an ID: `addressId`), or one that isn't in
 * its list once the list has arrived. The page says so rather than searching.
 */
export function noSuchOf(search: Pick<TransactionSearch, 'account' | 'category'>, accounts: Listed, categories: Listed): 'Account' | 'Category' | null {
  const missing = (id: number | 'uncategorised' | undefined, list: Listed) => typeof id === 'number' && (id === 0 || (list !== undefined && !list.some((item) => item.id === id)))
  return missing(search.account, accounts) ? 'Account' : missing(search.category, categories) ? 'Category' : null
}

/** The search's filters alone, which are all that decide how many Transactions match: no sort, no page. */
export const filtersOf = ({ account, category, transfers, from, to, q }: TransactionSearch): TransactionSearch => tidy({ account, category, transfers, from, to, q })

/** What the Export page keeps in its address: the filters alone, read as the Transactions page reads them. It has no list, so a sort or a page in the address is left out. */
export const parseExportSearch = (raw: Record<string, unknown>): TransactionSearch => filtersOf(parseTransactionSearch(raw))

/** The API's parameters for the filters alone. Blank ones are left out. */
export function filterQuery(search: TransactionSearch): Record<string, string> {
  const query: Record<string, string> = {}
  if (search.account !== undefined) query.accountId = String(search.account)
  if (search.category === 'uncategorised') query.uncategorised = 'true'
  else if (search.category !== undefined) query.categoryId = String(search.category)
  if (search.transfers) query.transfers = search.transfers
  if (search.from) query.from = search.from
  if (search.to) query.to = search.to
  if (search.q) query.text = search.q
  return query
}

/** The most Transactions a CSV export holds (worker/transaction-search.test.ts pins the two together). */
export const EXPORT_MAX_ROWS = 5_000

/**
 * Where the CSV export of this search's filters is. The export takes the filters and nothing else, so a sort or page in the
 * address is left out. Opened as a link, it downloads, and its file is named by its dates.
 */
export function exportPath(search: TransactionSearch): string {
  const query = new URLSearchParams(filterQuery(search)).toString()
  return `/api/transactions/export.csv${query ? `?${query}` : ''}`
}

/** The API's query string for this search and a page of `pageSize`. Blank filters are left out. */
export function apiQuery(search: TransactionSearch, pageSize: number): Record<string, string> {
  const query = filterQuery(search)
  if (search.sort || search.dir) Object.assign(query, sortOf(search))
  query.limit = String(pageSize)
  query.offset = String(((search.page ?? 1) - 1) * pageSize)
  return query
}
