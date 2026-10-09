import { hc } from 'hono/client'
import type { AppType } from '../../worker/index'

/** Typed client for the Worker's API: paths, params and responses come from the Hono app itself. */
export const api = hc<AppType>('/').api
