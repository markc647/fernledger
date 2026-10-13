// How much of D1 Free's daily allowance the Cloudflare account has used today, for the Rules page's usage bar (README: What it does).
//
// This is the one module besides Akahu's that calls out, and the one call it makes is to the Deployer's own Cloudflare account:
// POST https://api.cloudflare.com/client/v4/graphql, with the Deployer's own token (Account Analytics: Read, nothing more), only
// when both CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID are set (worker/features.ts: D1_USAGE). It sends no Fernledger data, only the account
// ID and a date. ADR 0010 says why that keeps the promise; worker/outbound.test.ts and scripts/outbound-calls.test.mjs hold it to this
// one address.
//
// The query is the account-wide form of the one in Cloudflare's D1 "Metrics and analytics" page
// (developers.cloudflare.com/d1/observability/metrics-analytics): dataset d1AnalyticsAdaptiveGroups, an `accountTag` filter, `date_geq`
// and `date_leq` filters, and `sum { rowsRead rowsWritten }`. It names no database, because the allowance is the account's. D1's day is
// UTC (it resets at 00:00 UTC: developers.cloudflare.com/d1/platform/pricing), and Cloudflare's GraphQL dates are UTC too.
//
// The figures lag by a few minutes. The call can fail in every way a network call can, and a 200 can carry `errors`
// (developers.cloudflare.com/analytics/graphql-api/errors), so any answer that is not the two figures is "unavailable": it is logged
// as an event and an error class (never a message, which can echo a token) and the page says so. This request never touches D1, so
// it still answers once the day's allowance is gone.
import * as z from 'zod/mini'
import { logEvent } from './log'
import { utcDay } from './rule-rerun'

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
/** D1 Free's daily allowance of rows read and rows written (developers.cloudflare.com/d1/platform/pricing). */
export const READ_LIMIT = 5_000_000
export const WRITE_LIMIT = 100_000
/** Longest the call may take. The Worker waits on it without using CPU, but a request that hangs is no use to the page. */
export const TIMEOUT_MS = 5_000

export type D1Usage = { rowsRead: number; rowsWritten: number; readLimit: number; writeLimit: number; resetsAt: string }

const QUERY = `query D1RowsToday($accountTag: string!, $start: Date, $end: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
        sum {
          rowsRead
          rowsWritten
        }
      }
    }
  }
}`

const rows = z.int().check(z.minimum(0))
const group = z.object({ sum: z.object({ rowsRead: rows, rowsWritten: rows }) })
// One account, the one asked about. None means the token cannot see it, and that is "unavailable", not "no rows".
const answer = z.object({
  errors: z.nullish(z.array(z.unknown())),
  data: z.object({ viewer: z.object({ accounts: z.array(z.object({ d1AnalyticsAdaptiveGroups: z.array(group) })).check(z.length(1)) }) }),
})

/** The next 00:00 UTC after `now`: when D1's allowance resets. */
export const nextReset = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()

/** Today's rows read and written by every database in the account, or null (after logging why) when Cloudflare cannot say. */
export async function readD1Usage(env: Pick<Env, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID'>, now = new Date()): Promise<D1Usage | null> {
  const day = utcDay(now)
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { accountTag: env.CF_ACCOUNT_ID, start: day, end: day } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      // 401 and 403 mean the token or account ID is wrong, which is the Deployer's to fix; anything else is Cloudflare's or the network's.
      logEvent(res.status === 401 || res.status === 403 ? 'd1-usage.refused' : 'd1-usage.failed')
      return null
    }
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'errors' in body && Array.isArray(body.errors) && body.errors.length > 0) {
      logEvent('d1-usage.failed')
      return null
    }
    const parsed = z.safeParse(answer, body)
    if (!parsed.success) {
      logEvent('d1-usage.unreadable')
      return null
    }
    const groups = parsed.data.data.viewer.accounts.flatMap((account) => account.d1AnalyticsAdaptiveGroups)
    return {
      rowsRead: groups.reduce((total, group) => total + group.sum.rowsRead, 0),
      rowsWritten: groups.reduce((total, group) => total + group.sum.rowsWritten, 0),
      readLimit: READ_LIMIT,
      writeLimit: WRITE_LIMIT,
      resetsAt: nextReset(now),
    }
  } catch (error) {
    // A body that is not JSON; anything else (no network, a timeout) is a failure of the call itself.
    logEvent(error instanceof SyntaxError ? 'd1-usage.unreadable' : 'd1-usage.failed', error instanceof SyntaxError ? {} : { error })
    return null
  }
}
