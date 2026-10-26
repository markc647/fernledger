import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import type { D1Usage } from './d1-usage'
import { HttpError, reasonOf } from './me'

// A failure is an HttpError carrying the Worker's `reason` (a 502 says why there are no figures). A component asks only when the feature is set up (featuresQuery: `d1-usage`), so a
// Deployer who hasn't turned it on makes no request.
const readUsage = async (): Promise<D1Usage> => {
  const res = await api['d1-usage'].$get()
  if (!res.ok) throw new HttpError(res.status, await reasonOf(res))
  return res.json()
}

/**
 * Today's D1 rows read and written for the whole Cloudflare account (worker/d1-usage.ts). It loads each time the bar shows (the Rules page's question before the Rules are
 * applied opens, or a run that is paused for the allowance is shown): no timer, no refetch when the window is focused, and no retry, so a failure shows at once. The page shows
 * no figures after a failure, old ones included.
 */
export const d1UsageQuery = queryOptions({
  queryKey: ['d1-usage'],
  queryFn: readUsage,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
  // Dropped as soon as nothing shows it, and stale the moment it is read: when it shows again (the question opens, the run pauses) the old figures are not shown while the new ones come.
  gcTime: 0,
  staleTime: 0,
})

/** How often the header reads the figures while the Admin has Fernledger open and in view (ADR 0010). Cloudflare's own figures run a few minutes behind, so more often would show nothing new. */
export const ALLOWANCE_REFRESH_MS = 5 * 60_000

/**
 * The same figures for the Admin's header (src/components/allowance-bar.tsx), which is on every page. A query of its own, because the question above is fresh each time it opens and
 * keeps nothing, and a key shared with it would show the header's older figures in it while its own came. This one is read as the page loads, every five minutes while the window is in
 * view (a background tab does not ask), and when the window is used again if the last reading is that old (`staleTime` is the interval, so a window that is used a lot asks no more often
 * than one that is not: about 12 an hour at the most for each open window). Going from page to page asks for nothing: the header stays. A failure is not retried before the next of
 * these, and the bar then says it does not know.
 */
export const d1AllowanceQuery = queryOptions({
  queryKey: ['d1-usage', 'allowance'],
  queryFn: readUsage,
  refetchInterval: ALLOWANCE_REFRESH_MS,
  refetchOnWindowFocus: true,
  staleTime: ALLOWANCE_REFRESH_MS,
  retry: false,
})
