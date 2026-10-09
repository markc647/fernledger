import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'
import { apiQuery, type TransactionSearch } from './transaction-search'

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

/** One page of Transactions for a search (filters, sort and page), as the API returns it. Every key starts with 'transactions', so saving an Override or Note refreshes them all. */
export const transactionsQuery = (search: TransactionSearch) =>
  queryOptions({
    queryKey: ['transactions', 'list', search],
    queryFn: async () => {
      const res = await api.transactions.$get({ query: apiQuery(search, PAGE_SIZE) })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
  })

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

/** The Categories in use, by name. */
export const categoriesQuery = queryOptions({
  queryKey: ['categories'],
  queryFn: async () => {
    const res = await api.categories.$get()
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
