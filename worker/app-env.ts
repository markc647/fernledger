import type { Member } from './auth'

/** The Hono environment every route shares: the Worker's bindings and the signed-in Member set by the auth middleware. */
export type AppEnv = { Bindings: Env; Variables: { member: Member } }
