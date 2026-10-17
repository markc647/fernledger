import { queryOptions } from '@tanstack/react-query'
import { api } from './api'

export class HttpError extends Error {
  status: number
  /** What the Worker says a 409 means, when a page needs to tell one 409 from another (`reason` in the body; worker/validate.ts `CHANGED_MEANWHILE`). */
  reason?: string
  constructor(status: number, reason?: string) {
    super(`API request failed with ${status}`)
    this.status = status
    this.reason = reason
  }
}

/** The `reason` a refusal's body gives, if it has one. */
export const reasonOf = async (res: { json: () => Promise<unknown> }): Promise<string | undefined> => {
  const body = (await res.json().catch(() => null)) as { reason?: unknown } | null
  return typeof body?.reason === 'string' ? body.reason : undefined
}

/** Who is signed in, from Access (or the localhost dev identity). Rejects with an HttpError when the API says no. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  retry: false,
  queryFn: async () => {
    const res = await api.me.$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})
