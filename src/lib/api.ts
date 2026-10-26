import { hc } from 'hono/client'
import type { AppType } from '@/generated/api/app'
import { busyRetryingFetch } from './member-busy'
import { sessionAwareFetch } from './session'

/**
 * Typed client for the Worker's API: paths, params and responses come from the Hono app itself. Every call goes through `sessionAwareFetch`, so an Access redirect (an expired
 * sign-in) or a 401 is noticed whichever call meets it (src/lib/session.ts), and a 429 `member-busy` is asked again shortly (src/lib/member-busy.ts).
 */
/** The client's own `fetch`, for an API answer that isn't JSON (the CSV export). Only for this app's own API, as the CSP holds it to (ADR 0010). */
export const apiFetch = sessionAwareFetch(busyRetryingFetch())

export const api = hc<AppType>('/', { fetch: apiFetch }).api
