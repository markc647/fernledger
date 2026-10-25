import { useSyncExternalStore } from 'react'
import { formatNzTime, nzDate } from './format'

/** How long a request keeps being asked again while the Worker says the Member is busy, before its answer is shown as it is. */
export const BUSY_GIVE_UP_MS = 10_000

/** Why the Worker refused a request with a 429 (`reason` in its body), if it did. Read here, not with me.ts's `reasonOf`, which would import the API client back. */
const refusedFor = async (res: Response) => {
  if (res.status !== 429) return undefined
  const body = (await res.clone().json().catch(() => null)) as { reason?: unknown } | null
  return body?.reason
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

/** The UTC day a request was last refused for the Members' daily read limit (`member-reads`): it lasts until 00:00 UTC (worker/member-read-limit.ts). */
let limitDay: string | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Whether a request has been refused today (UTC) because the Members' daily read limit was reached. */
export const dayLimitReached = (now = Date.now()) => limitDay === utcDay(now)

/** The same, re-rendering when a refusal is first met. The page reads it again when it next renders after 00:00 UTC. */
export const useDayLimitReached = () => useSyncExternalStore(subscribe, () => dayLimitReached())

const noteDayLimit = () => {
  const today = utcDay(Date.now())
  if (limitDay === today) return
  limitDay = today
  for (const listener of listeners) listener()
}

/** When the Members' daily read limit starts again: the next 00:00 UTC, as New Zealand time ("1:00 pm today", or "12:00 pm tomorrow" in winter). */
export function dayLimitResets(now = Date.now()) {
  const day = new Date(now)
  const reset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)
  return `${formatNzTime(reset)} ${nzDate(reset) === nzDate(now) ? 'today' : 'tomorrow'}`
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Asks again, after a short wait, a request the Worker answered 429 `member-busy`: a Member has as many dear requests in flight as the
 * Members' daily read limit allows at once (worker/member-read-limit.ts `MEMBER_MAX_IN_FLIGHT`), as when a page sends its own requests
 * together, so they go in turn. The waits grow from about 100 ms to about a second, each between half and one and a half times that, so
 * a page's requests don't all come back together. After BUSY_GIVE_UP_MS the answer is handed on as it is. `member-reads`, the day's
 * limit, is never asked again, and nor is a request with a body, which can't be sent twice. A `member-reads` answer is noted, so the page
 * can say why its reads fail and when they work again (`useDayLimitReached`).
 */
export const busyRetryingFetch =
  (inner: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      const res = await inner(input, init)
      const reason = await refusedFor(res)
      if (reason === 'member-reads') noteDayLimit()
      if (init?.body != null || reason !== 'member-busy' || Date.now() - started >= BUSY_GIVE_UP_MS) return res
      await wait(Math.min(1_000, 100 * 2 ** attempt) * (0.5 + Math.random()))
    }
  }
