import { queryOptions } from '@tanstack/react-query'
import type { PreviewRow } from '@/generated/api/import-rows'
import { api } from './api'
import type { CarryPreview } from './import-carry'
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

/** One page of Transactions, newest first; with `uncategorised`, only those with no Category. `page` is 0-based. */
export const transactionsQuery = (page: number, uncategorised = false) =>
  queryOptions({
    queryKey: ['transactions', { uncategorised }, page],
    queryFn: async () => {
      const query: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) }
      if (uncategorised) query.uncategorised = 'true'
      const res = await api.transactions.$get({ query })
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

/**
 * What a replace with this file would do with the Account's Overrides and Notes: asked of the Worker a chunk of the file's
 * IDs and amounts at a time (the Worker takes at most CHUNK_SIZE in a request), and added up. Nothing is changed. `key` says
 * which file and Cutover Date the chunks are of. Read fresh each time it's asked.
 */
export const carryPreviewQuery = (accountId: number, chunks: PreviewRow[][], key: string) =>
  queryOptions({
    queryKey: ['carry-preview', accountId, key],
    gcTime: 0,
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
    const res = await api.transactions.$get({ query: { limit: String(RECENT_TRANSACTIONS) } })
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})
