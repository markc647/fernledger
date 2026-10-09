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
