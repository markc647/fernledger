import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'

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

/** One page of Transactions, newest first. `page` is 0-based. */
export const transactionsQuery = (page: number) =>
  queryOptions({
    queryKey: ['transactions', page],
    queryFn: async () => {
      const res = await api.transactions.$get({ query: { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

/** How many Import-sourced Transactions an Account holds, so a replace can say what it will remove. Read fresh each time it's asked. */
export const importedRowsQuery = (accountId: number) =>
  queryOptions({
    queryKey: ['imported-rows', accountId],
    gcTime: 0,
    queryFn: async () => {
      const res = await api.imports.imported[':accountId'].$get({ param: { accountId: String(accountId) } })
      if (!res.ok) throw new HttpError(res.status)
      return (await res.json()).imported
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
    const res = await api.transactions.$get({ query: { limit: String(RECENT_TRANSACTIONS) } })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})
