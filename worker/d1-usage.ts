// How much of D1 Free's daily allowance the Cloudflare account has used today, for the Rules page's usage bar (README: What it does).
//
// This is the one place the Worker's own code calls `fetch` (worker/auth.ts reaches Access through jose, which fetches the keys for it;
// Akahu Sync will add a module of its own). The call is to the Deployer's own Cloudflare account:
// POST https://api.cloudflare.com/client/v4/graphql, with the Deployer's own token (Account Analytics: Read, nothing more), only
// when both CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID are set (worker/features.ts: D1_USAGE). It sends no Fernledger data, only the account
// ID and a date. ADR 0010 says why that keeps the promise; worker/outbound.test.ts and scripts/outbound-calls.test.mjs hold it to this
// one address.
//
// The query is the account-wide form of the one in Cloudflare's D1 "Metrics and analytics" page
// (developers.cloudflare.com/d1/observability/metrics-analytics): dataset d1AnalyticsAdaptiveGroups, an `accountTag` filter, `date_geq`
// and `date_leq` filters, and `sum { rowsRead rowsWritten }`. It names no database, because the allowance is the account's. D1's day is
// UTC (the allowance resets at 00:00 UTC: developers.cloudflare.com/d1/platform/pricing). The GraphQL docs show `Date` values as plain
// dates in examples they say are UTC, but never say outright that the `date` dimension is the UTC day, so asking for today's UTC date
// is unverified until the first live run (docs/setup.md says how to check). Nor do they say what an account ID the token cannot see
// comes back as: an empty `accounts` list (reason no-account), or an error. Either way the page says so and does not guess.
//
// The figures lag by a few minutes. The call can fail in every way a network call can, and a 200 can carry `errors`
// (developers.cloudflare.com/analytics/graphql-api/errors), so any answer that is not the two figures is "unavailable", with one of
// four fixed reasons (UnavailableReason) and no word of what Cloudflare said, which can echo the token. Each is logged as an event
// name, and an error class when there is one, and nothing else. This request never touches D1, so it still answers once the day's
// allowance is gone.
import * as z from 'zod/mini'
import { utcDay } from './dates'
import { DAILY_ROW_WRITES } from './import-rows'
import { logEvent } from './log'

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
/** D1 Free's daily allowance of rows read (developers.cloudflare.com/d1/platform/pricing); rows written is DAILY_ROW_WRITES (ADR 0004). */
export const READ_LIMIT = 5_000_000
/** Longest the call may take, reading the answer included. The Worker waits on it without using CPU, but a request that hangs is no use to the page. */
export const TIMEOUT_MS = 5_000

/**
 * Why there are no figures, for the page to say what to check:
 * - refused: Cloudflare answered 401 or 403, so the token or the account ID is wrong.
 * - no-account: it answered, but with no account, so the account ID is not one the token can see.
 * - unreachable: it could not be reached, was too slow, or answered with another error status.
 * - unreadable: it answered, but not with the two figures (not JSON, a 200 carrying `errors`, or another shape).
 */
export type UnavailableReason = 'refused' | 'no-account' | 'unreachable' | 'unreadable'

export type D1Usage = { rowsRead: number; rowsWritten: number; readLimit: number; writeLimit: number; resetsAt: string }

export type UsageResult = { ok: true; usage: D1Usage } | { ok: false; reason: UnavailableReason }

/** The log event for each reason (docs/setup.md lists them). */
const EVENTS: Record<UnavailableReason, string> = {
  refused: 'd1-usage.refused',
  'no-account': 'd1-usage.no-account',
  unreachable: 'd1-usage.failed',
  unreadable: 'd1-usage.unreadable',
}

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

// A sum can come back null for a group with nothing in it, which is zero rows; a figure that is missing, negative or not whole is not an answer.
const rows = z.nullable(z.int().check(z.minimum(0)))
const group = z.object({ sum: z.object({ rowsRead: rows, rowsWritten: rows }) })
const answer = z.object({
  errors: z.nullish(z.array(z.unknown())),
  data: z.object({ viewer: z.object({ accounts: z.array(z.object({ d1AnalyticsAdaptiveGroups: z.array(group) })) }) }),
})

/** The next 00:00 UTC after `now`: when D1's allowance resets. (The browser has its own for a page with no usage data to go on: src/lib/rerun.ts.) */
export const nextReset = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()

const unavailable = (reason: UnavailableReason, error?: unknown): UsageResult => {
  logEvent(EVENTS[reason], error === undefined ? {} : { error })
  return { ok: false, reason }
}

/** Today's rows read and written by every database in the account, or why there are none (logged). */
export async function readD1Usage(env: Pick<Env, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID'>, now = new Date()): Promise<UsageResult> {
  const day = utcDay(now)
  // Trimmed as features.ts reads them: a secret pasted with a trailing newline is set, and has to work.
  const token = env.CF_ANALYTICS_TOKEN?.trim() ?? ''
  const accountTag = env.CF_ACCOUNT_ID?.trim() ?? ''
  // The limit is a timer and not AbortSignal.timeout, so a test can move it (a faked clock does not move that one).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { accountTag, start: day, end: day } }),
      signal: controller.signal,
      // The token goes to this address only: a redirect is not followed, so it would take the token somewhere else. ('manual' hands the 3xx back,
      // which is not ok and so is "unreachable". Workers' fetch has no 'error' mode: workerd refuses to build the request, which outbound.test.ts caught.)
      redirect: 'manual',
    })
    // 401 and 403 mean the token or account ID is wrong, which is the Deployer's to fix; any other status is Cloudflare's or the network's.
    if (!res.ok) return unavailable(res.status === 401 || res.status === 403 ? 'refused' : 'unreachable')
    const body: unknown = await res.json()
    const parsed = z.safeParse(answer, body)
    // Unverified until the first live run: whether an authorisation failure ever comes back as a 200 carrying `errors`. The GraphQL docs list
    // the messages for it ("not authorized for that account") against HTTP 403, with no error code to match on a 200, so a 200 with errors is unreadable.
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) return unavailable('unreadable')
    const accounts = parsed.data.data.viewer.accounts
    if (accounts.length === 0) return unavailable('no-account')
    const groups = accounts.flatMap((account) => account.d1AnalyticsAdaptiveGroups)
    return {
      ok: true,
      usage: {
        rowsRead: groups.reduce((total, { sum }) => total + (sum.rowsRead ?? 0), 0),
        rowsWritten: groups.reduce((total, { sum }) => total + (sum.rowsWritten ?? 0), 0),
        readLimit: READ_LIMIT,
        writeLimit: DAILY_ROW_WRITES,
        resetsAt: nextReset(now),
      },
    }
  } catch (error) {
    // A body that is not JSON is Cloudflare answering badly; anything else (no network, the time limit) is the call failing.
    return error instanceof SyntaxError ? unavailable('unreadable') : unavailable('unreachable', error)
  } finally {
    clearTimeout(timer)
  }
}
