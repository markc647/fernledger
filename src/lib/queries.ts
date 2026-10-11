import { queryOptions } from '@tanstack/react-query'
import type { PreviewRow } from '@/generated/api/import-rows'
import { api } from './api'
import type { NetWorthRange, SpendingPeriod } from './charts'
import type { CarryPreview } from './import-carry'
import { HttpError } from './me'
import { loadBalances } from './report-balances'
import { loadListing } from './report-transactions'
import { apiQuery, filterQuery, filtersOf, type TransactionSearch } from './transaction-search'

export const PAGE_SIZE = 50

export const accountsQuery = queryOptions({
  queryKey: ['accounts'],
  queryFn: async () => {
    const res = await api.accounts.$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

export const CHANGE_LOG_PAGE_SIZE = 50

export type ChangeLogFilters = { type: string; from: string; to: string }

/** One page of the Change Log, newest first. Blank filters are left out. `page` is 0-based. */
export const changeLogQuery = (filters: ChangeLogFilters, page: number) =>
  queryOptions({
    queryKey: ['change-log', filters, page],
    queryFn: async () => {
      const query: Record<string, string> = { limit: String(CHANGE_LOG_PAGE_SIZE), offset: String(page * CHANGE_LOG_PAGE_SIZE) }
      for (const key of ['type', 'from', 'to'] as const) if (filters[key]) query[key] = filters[key]
      const res = await api['change-log'].$get({ query })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/**
 * One page of Transactions for a search (filters, sort and page), as the API returns it, without a count: counting reads
 * every Transaction the filters keep (ADR 0004), so it is `transactionCountQuery`'s, asked once per search and not per page.
 * Every key starts with 'transactions', so saving an Override or Note refreshes them all.
 */
export const transactionsQuery = (search: TransactionSearch) =>
  queryOptions({
    queryKey: ['transactions', 'list', search],
    queryFn: async () => {
      const res = await api.transactions.$get({ query: { ...apiQuery(search, PAGE_SIZE), count: 'false' } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/** How many Transactions a search matches. Only its filters count, so paging and sorting reuse the answer instead of asking again. */
export const transactionCountQuery = (search: TransactionSearch) => {
  const filters = filtersOf(search)
  return queryOptions({
    queryKey: ['transactions', 'count', filters],
    queryFn: async () => {
      const res = await api.transactions.$get({ query: { ...filterQuery(filters), count: 'only' } })
      if (!res.ok) throw new HttpError(res.status)
      const { total } = await res.json()
      if (total === null) throw new Error('The API did not count') // count=only always does; this narrows the type
      return total
    },
  })
}

/** One Transaction in full. A 404 means there is no such Transaction. */
export const transactionQuery = (id: string) =>
  queryOptions({
    queryKey: ['transactions', 'detail', id],
    retry: (count, error) => !(error instanceof HttpError && error.status === 404) && count < 3,
    queryFn: async () => {
      const res = await api.transactions[':id'].$get({ param: { id } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/**
 * The Transaction listing Report's data: every Transaction of `accounts` in the range, a page at a time (loadListing), up to
 * the cap. The pages are read once and kept: a Report is a snapshot ("Generated … at …" is when the data arrived), so a refocused
 * window doesn't read thousands of rows again.
 */
export const reportListingQuery = (accounts: { id: number; name: string; accountNumber: string }[], from: string, to: string) =>
  queryOptions({
    queryKey: ['reports', 'transactions', accounts.map((a) => a.id), from, to],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () =>
      loadListing({
        accounts,
        from,
        to,
        fetchPage: async ({ accountId, after, limit, ...range }) => {
          const res = await api.reports.transactions.$get({ query: { accountId: String(accountId), ...range, limit: String(limit), ...(after === undefined ? {} : { after }) } })
          if (!res.ok) throw new HttpError(res.status)
          return res.json()
        },
      }),
  })

/**
 * The balances-over-time Report's data: each Account's balance history at the end of each month in the range, one request for each
 * Account (loadBalances). Read once and kept, as the Transaction listing is: a Report is a snapshot.
 */
export const reportBalancesQuery = (accounts: { id: number; name: string; accountNumber: string; cutoverDate: string | null }[], from: string, to: string) =>
  queryOptions({
    queryKey: ['reports', 'balances', accounts.map((a) => a.id), from, to],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () =>
      loadBalances({
        accounts,
        from,
        to,
        fetchReport: async ({ accountId, ...range }) => {
          const res = await api.reports.balances.$get({ query: { accountId: String(accountId), ...range } })
          if (!res.ok) throw new HttpError(res.status)
          return res.json()
        },
      }),
  })

/**
 * The spending-by-Category Report's data: what each Spending Category spent over the range, for the one Account or, with none, all of
 * them. One request either way (worker/report-spending.ts). Read once and kept, as the other Reports are: a Report is a snapshot.
 */
export const reportSpendingQuery = (accountId: number | undefined, from: string, to: string) =>
  queryOptions({
    queryKey: ['reports', 'spending', accountId ?? null, from, to],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await api.reports.spending.$get({ query: { ...(accountId === undefined ? {} : { accountId: String(accountId) }), from, to } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/** The Categories in use, by name. */
export const categoriesQuery = queryOptions({
  queryKey: ['categories'],
  queryFn: async () => {
    const res = await api.categories.$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

/**
 * Every Category in use with the Budget it has this NZ month (the Worker decides which month that is) and all of its Budget changes.
 * Every key starts with 'budgets', so saving a Budget refreshes both.
 */
export const budgetsQuery = queryOptions({
  queryKey: ['budgets', 'list'],
  queryFn: async () => {
    const res = await api.budgets.$get({ query: {} })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

/** This NZ month's Budget vs actual: each Category that has a Budget, with what it has spent. */
export const budgetVsActualQuery = queryOptions({
  queryKey: ['budgets', 'vs-actual'],
  queryFn: async () => {
    const res = await api.budgets['vs-actual'].$get({ query: {} })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

/** How many Import-sourced Transactions an Account holds, and how many of them have an Override or a Note, so a replace can say what it will remove. Read fresh each time it's asked. */
export const importedRowsQuery = (accountId: number) =>
  queryOptions({
    queryKey: ['imported-rows', accountId],
    gcTime: 0,
    queryFn: async () => {
      const res = await api.imports.imported[':accountId'].$get({ param: { accountId: String(accountId) } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/**
 * What a replace with this file would do with the Account's Overrides, Notes and Not a Transfer marks: asked of the Worker a chunk of the file's
 * IDs and amounts at a time (the Worker takes at most CHUNK_SIZE in a request), and added up. Nothing is changed. `key` says
 * which file and Cutover Date the chunks are of. Read fresh each time it's asked.
 */
export const carryPreviewQuery = (accountId: number, chunks: PreviewRow[][], key: string) =>
  queryOptions({
    queryKey: ['carry-preview', accountId, key],
    gcTime: 0,
    // Not re-asked on window focus or while open: each ask reads the Account's history (ADR 0004). Discarding refetches it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<CarryPreview> => {
      const preview: CarryPreview = { waiting: 0, carries: 0, differing: 0 }
      for (const rows of chunks) {
        const res = await api.imports['carry-preview'].$post({ json: { accountId, rows } })
        if (!res.ok) throw new HttpError(res.status)
        const body = await res.json()
        if (!('waiting' in body)) throw new HttpError(res.status)
        preview.waiting = body.waiting
        preview.carries += body.carries
        preview.differing += body.differing
      }
      return preview
    },
  })

/** Every Account's balance now, from its latest bank balance. */
export const balancesQuery = queryOptions({
  queryKey: ['balances'],
  queryFn: async () => {
    const res = await api.balances.$get()
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()).accounts
  },
})

/** Balance Check warnings (where the bank and the Transactions disagree), and each Account's latest check. */
export const balanceChecksQuery = queryOptions({
  queryKey: ['balance-checks'],
  queryFn: async () => {
    const res = await api['balance-checks'].$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

export const RECENT_TRANSACTIONS = 5

/** The newest few Transactions, for the Summary. */
export const recentTransactionsQuery = queryOptions({
  queryKey: ['transactions', 'recent'],
  queryFn: async () => {
    // No count: the Summary shows no total, and counting would read every Transaction on every visit (ADR 0004).
    const res = await api.transactions.$get({ query: { limit: String(RECENT_TRANSACTIONS), count: 'false' } })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

/**
 * Net worth at the end of each month, for a range. Working it out reads every Transaction of every Account about six times whatever the range (ADR 0004), so the
 * answer is kept for five minutes and not asked again when the window is refocused. The key starts with 'balances', so an Import or a Cutover Date, which change
 * the balances, ask again.
 */
export const netWorthQuery = (range: NetWorthRange) =>
  queryOptions({
    queryKey: ['balances', 'net-worth', range],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1, // a failed answer has already read a great deal, so it is asked for once more at most (ADR 0004)
    queryFn: async () => {
      const res = await api.charts['net-worth'].$get({ query: { range } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/** Which spending the chart is of: a period the Worker names (so "this month" is a NZ month whatever the device's clock), or two dates. */
export type SpendingChoice = { period: SpendingPeriod } | { from: string; to: string }

/** Spending by Category for a period or two dates, Transfers left out. It reads the Transactions in those dates (ADR 0004), so it is asked again only when the choice changes or the page is opened. */
export const spendingByCategoryQuery = (choice: SpendingChoice) =>
  queryOptions({
    queryKey: ['spending', choice],
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const res = await api.charts.spending.$get({ query: choice })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })
