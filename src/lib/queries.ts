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
