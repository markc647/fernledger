import { queryOptions } from '@tanstack/react-query'
import { api } from './api'

/** Who is signed in, from Access (or the localhost dev identity). Rejects when the API says no. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  retry: false,
  queryFn: async () => {
    const res = await api.me.$get()
    if (!res.ok) throw new Error(`GET /api/me failed with ${res.status}`)
    return res.json()
  },
})
