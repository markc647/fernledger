/** How long a request keeps being asked again while the Worker says the Member is busy, before its answer is shown as it is. */
export const BUSY_GIVE_UP_MS = 10_000

const isBusy = async (res: Response) => {
  if (res.status !== 429) return false
  try {
    return ((await res.clone().json()) as { reason?: unknown }).reason === 'member-busy'
  } catch {
    return false
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Asks again, after a short wait, a request the Worker answered 429 `member-busy`: a Member has as many dear requests in flight as the
 * Members' daily read limit allows at once (worker/member-read-limit.ts `MEMBER_MAX_IN_FLIGHT`), as when a page sends its own requests
 * together, so they go in turn. The waits grow from about 100 ms to about a second, each between half and one and a half times that, so
 * a page's requests don't all come back together. After BUSY_GIVE_UP_MS the answer is handed on as it is. `member-reads`, the day's
 * limit, is never asked again, and nor is a request with a body, which can't be sent twice.
 */
export const busyRetryingFetch =
  (inner: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      const res = await inner(input, init)
      if (init?.body != null || !(await isBusy(res)) || Date.now() - started >= BUSY_GIVE_UP_MS) return res
      await wait(Math.min(1_000, 100 * 2 ** attempt) * (0.5 + Math.random()))
    }
  }
