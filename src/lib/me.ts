import { queryOptions } from '@tanstack/react-query'
import { api } from './api'

export class HttpError extends Error {
  status: number
  constructor(status: number) {
    super(`API request failed with ${status}`)
    this.status = status
  }
}

/** True when the API said the visitor isn't signed in (401), as opposed to the API or network failing. */
export const isNotSignedIn = (error: unknown) => error instanceof HttpError && error.status === 401

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
