import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import type { D1Usage } from './d1-usage'
import { HttpError, reasonOf } from './me'

/**
 * Today's D1 rows read and written for the whole Cloudflare account (worker/d1-usage.ts). It loads each time the bar shows (the Rules page's question before the Rules are
 * applied opens, and the figures of the last time are stale by then, so they are read again): no timer, no refetch when the window is focused, and no retry, so a failure shows at once. A failure
 * is an HttpError carrying the Worker's `reason` (a 502 says why there are no figures), and the page shows no figures after one, old ones included.
 * A component asks only when the feature is set up (featuresQuery: `d1-usage`), so a Deployer who hasn't turned it on makes no request.
 */
export const d1UsageQuery = queryOptions({
  queryKey: ['d1-usage'],
  queryFn: async (): Promise<D1Usage> => {
    const res = await api['d1-usage'].$get()
    if (!res.ok) throw new HttpError(res.status, await reasonOf(res))
    return res.json()
  },
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
})
