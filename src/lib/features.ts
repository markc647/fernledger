import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'
import { retryAtMost } from './session'

/**
 * Which optional features are switched off for want of configuration. The Worker words each message for the
 * visitor's role: the Admin gets "Setup needed: what and how", a Member gets a neutral line.
 */
export const featuresQuery = queryOptions({
  queryKey: ['features'],
  retry: retryAtMost(1), // the Balances table waits for it to know whether to show its Sync column
  queryFn: async () => {
    const res = await api.features.$get()
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()).features
  },
})
