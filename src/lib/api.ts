import { hc } from 'hono/client'
import type { AppType } from '@/generated/api/app'
import { sessionAwareFetch } from './session'

/**
 * Typed client for the Worker's API: paths, params and responses come from the Hono app itself. Every call goes through `sessionAwareFetch`, so an Access redirect (an expired
 * sign-in) or a 401 is noticed whichever call meets it (src/lib/session.ts).
 */
export const api = hc<AppType>('/', { fetch: sessionAwareFetch() }).api
