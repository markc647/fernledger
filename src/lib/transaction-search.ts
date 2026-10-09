import { isSearchDate } from './date-range'

// What the Transactions page keeps in its address, so a search survives a reload and Back returns to it. The API's own
// parameters are built from it by `apiQuery`. Everything here is forgiving: an address typed or edited by hand never breaks the page.

/** The sorts the API accepts (worker/transaction-search.ts pins the two lists together in its test). */
export const SORT_KEYS = ['date', 'account', 'description', 'category', 'amount'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

/** The longest text the API searches for (worker/transaction-search.ts pins the two together in its test). */
export const MAX_TEXT = 100
/** The last page the address accepts: 100,000 pages of 50 is 5 million Transactions, far past any history the app is built for. */
const MAX_PAGE = 100_000

export type TransactionSearch = {
  /** An Account's ID. */
  account?: number
  /** A Category's ID, or 'uncategorised' for those with none. */
  category?: number | 'uncategorised'
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

/** The search without what is empty or already the default, so the address stays short. */
export function tidy(search: TransactionSearch): TransactionSearch {
  const { sort, dir } = sortOf(search)
  const tidied: TransactionSearch = {
    account: search.account,
    category: search.category,
    from: search.from || undefined,
    to: search.to || undefined,
    q: search.q || undefined,
    sort: sort === 'date' ? undefined : sort,
    dir: dir === defaultDirection(sort) ? undefined : dir,
    page: search.page && search.page > 1 ? search.page : undefined,
  }
  return Object.fromEntries(Object.entries(tidied).filter(([, value]) => value !== undefined))
}

const positiveInteger = (value: unknown, max: number) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : undefined
}

const searchDate = (value: unknown) => (typeof value === 'string' && isSearchDate(value) ? value : undefined)

/**
 * Reads the address's search parameters, which the router has already parsed (so `?q=2026` arrives as a number and `?account=2`
 * as 2), into a TransactionSearch. Anything that isn't valid is left out rather than refused.
 */
export function parseTransactionSearch(raw: Record<string, unknown>): TransactionSearch {
  const text = typeof raw.q === 'string' || typeof raw.q === 'number' || typeof raw.q === 'boolean' ? String(raw.q).trim().slice(0, MAX_TEXT) : ''
  return tidy({
    account: positiveInteger(raw.account, 999_999_999),
    category: raw.category === 'uncategorised' ? 'uncategorised' : positiveInteger(raw.category, 999_999_999),
    from: searchDate(raw.from),
    to: searchDate(raw.to),
    q: text,
    sort: SORT_KEYS.find((key) => key === raw.sort),
    dir: raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : undefined,
    page: positiveInteger(raw.page, MAX_PAGE),
  })
}

/** The search's filters alone, which are all that decide how many Transactions match: no sort, no page. */
export const filtersOf = ({ account, category, from, to, q }: TransactionSearch): TransactionSearch => tidy({ account, category, from, to, q })

/** The API's parameters for the filters alone. Blank ones are left out. */
export function filterQuery(search: TransactionSearch): Record<string, string> {
  const query: Record<string, string> = {}
  if (search.account !== undefined) query.accountId = String(search.account)
  if (search.category === 'uncategorised') query.uncategorised = 'true'
  else if (search.category !== undefined) query.categoryId = String(search.category)
  if (search.from) query.from = search.from
  if (search.to) query.to = search.to
  if (search.q) query.text = search.q
  return query
}

/** The API's query string for this search and a page of `pageSize`. Blank filters are left out. */
export function apiQuery(search: TransactionSearch, pageSize: number): Record<string, string> {
  const query = filterQuery(search)
  if (search.sort || search.dir) Object.assign(query, sortOf(search))
  query.limit = String(pageSize)
  query.offset = String(((search.page ?? 1) - 1) * pageSize)
  return query
}
