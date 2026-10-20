// Akahu, read-only: the one third party the Worker ever contacts, and only when the Deployer has set both Akahu tokens
// (ADR 0008, ADR 0010; worker/features.ts: AKAHU_SYNC). With CSV Imports alone nothing here runs and no call is made.
//
// Every call is to https://api.akahu.io, from this file alone, so worker/outbound.test.ts and scripts/outbound-calls.test.mjs
// can hold the Worker to it. Akahu personal apps are read-only and cannot make payments (README: It can't move money).
//
// The API (developers.akahu.nz, "Accessing Transactional Data" and "The Transaction Model"), as at October 2026:
//   GET /v1/accounts                       the Akahu accounts the user token can see
//   GET /v1/accounts/{_id}/transactions    one account's Transactions, which is what Sync asks for: a linked Account
//                                          receives only its own, so Akahu seeing more accounts than you linked
//                                          cannot put them in the app (spec 31)
//   headers: Authorization: Bearer <user token>, X-Akahu-Id: <app token>
//   query:   start (EXCLUSIVE), end (inclusive), cursor; up to 100 items a page, `cursor.next` null on the last
//
// Nothing of Fernledger's is sent: the request carries the two tokens, an account ID and two instants. Errors are
// logged as an event and an error class, never a message, because a message can echo a token (worker/log.ts).
import * as z from 'zod/mini'
import { logEvent } from './log'

export const AKAHU_API = 'https://api.akahu.io/v1'

/** Longest one call may take. Akahu answers from its own store, not the bank, so this is generous. */
export const TIMEOUT_MS = 10_000

/**
 * Most pages one Sync will ask for, over all its Accounts. A Workers Free invocation gets 50 subrequests (ADR 0004) and the
 * cron has D1 writes to make with them, so Sync stops asking at this many and reports itself unfinished rather than being cut
 * off mid-write. At 100 Transactions a page that is 2,000 in a run, far more than a day or a 30-day re-check of a household's.
 * chisle: a flat cap for the whole run; ticket 28 (#29) gives Sync a budget it can resume against.
 */
export const MAX_PAGES = 20

/**
 * Why Sync could not read from Akahu, for the Admin to be told what to do (spec 22). Ticket 29 (#30) turns these into the
 * status banner's wording; here they are what the log and the caller see.
 * - refused: Akahu answered 401 or 403. The tokens are wrong or revoked, which is the Admin's to fix in Akahu.
 * - unreachable: it could not be reached, was too slow, or answered with another error status.
 * - unreadable: it answered, but not with Transactions (not JSON, or another shape).
 */
export type AkahuFailure = 'refused' | 'unreachable' | 'unreadable'

const EVENTS: Record<AkahuFailure, string> = {
  refused: 'akahu.refused',
  unreachable: 'akahu.unreachable',
  unreadable: 'akahu.unreadable',
}

/** What Akahu gives for one Transaction, narrowed to the fields Fernledger stores. Anything else in the object is ignored. */
export const akahuTransaction = z.object({
  _id: z.string(),
  _account: z.string(),
  // ISO 8601. Most NZ banks supply a date only, which arrives as midnight; `has_bank_time` in transactionRow says how that is read.
  date: z.string(),
  // When Akahu first saw it. Kept so nothing is lost if precision improves later (spec 51).
  created_at: z.string(),
  description: z.string(),
  // Dollars, negative for money out. Fernledger stores integer cents.
  amount: z.number(),
  type: z.string(),
  merchant: z.optional(z.object({ name: z.string() })),
  meta: z.optional(
    z.object({
      particulars: z.optional(z.string()),
      code: z.optional(z.string()),
      reference: z.optional(z.string()),
      other_account: z.optional(z.string()),
      card_suffix: z.optional(z.string()),
    }),
  ),
})

export type AkahuTransaction = z.infer<typeof akahuTransaction>

const page = z.object({
  items: z.array(akahuTransaction),
  // Absent on the last page in some answers, `{ next: null }` in others. Both mean there is no more.
  cursor: z.optional(z.nullable(z.object({ next: z.nullable(z.string()) }))),
})

export const akahuAccount = z.object({ _id: z.string(), name: z.string(), formatted_account: z.optional(z.string()) })
export type AkahuAccount = z.infer<typeof akahuAccount>

const accountsAnswer = z.object({ items: z.array(akahuAccount) })

export type AkahuResult<T> = { ok: true; value: T } | { ok: false; reason: AkahuFailure }

const failed = (reason: AkahuFailure, error?: unknown): { ok: false; reason: AkahuFailure } => {
  logEvent(EVENTS[reason], error === undefined ? {} : { error })
  return { ok: false, reason }
}

/** The two tokens, trimmed: a secret pasted with a trailing newline is set, and has to work (as worker/d1-usage.ts reads its own). */
export type AkahuTokens = { appToken: string; userToken: string }

export const akahuTokens = (env: Pick<Env, 'AKAHU_APP_TOKEN' | 'AKAHU_USER_TOKEN'>): AkahuTokens | null => {
  const appToken = env.AKAHU_APP_TOKEN?.trim() ?? ''
  const userToken = env.AKAHU_USER_TOKEN?.trim() ?? ''
  return appToken && userToken ? { appToken, userToken } : null
}

/** One GET to Akahu, parsed against `shape`, or why it could not be (logged). */
async function get<T>(path: string, tokens: AkahuTokens, shape: z.ZodMiniType<T>): Promise<AkahuResult<T>> {
  // A timer rather than AbortSignal.timeout, so a test can move it (a faked clock does not move that one), as d1-usage.ts does.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${AKAHU_API}${path}`, {
      headers: { Authorization: `Bearer ${tokens.userToken}`, 'X-Akahu-Id': tokens.appToken },
      signal: controller.signal,
      // The tokens go to this address only: a redirect, followed, would carry them somewhere else.
      redirect: 'manual',
    })
    if (!res.ok) return failed(res.status === 401 || res.status === 403 ? 'refused' : 'unreachable')
    const parsed = z.safeParse(shape, await res.json())
    return parsed.success ? { ok: true, value: parsed.data } : failed('unreadable')
  } catch (error) {
    // A body that is not JSON is Akahu answering badly; anything else (no network, the time limit) is the call failing.
    return error instanceof SyntaxError ? failed('unreadable') : failed('unreachable', error)
  } finally {
    clearTimeout(timer)
  }
}

/** The Akahu accounts the user token can see, for the Admin to pick from when linking an Account. Nothing is stored by asking. */
export const listAkahuAccounts = async (tokens: AkahuTokens): Promise<AkahuResult<AkahuAccount[]>> => {
  const answer = await get('/accounts', tokens, accountsAnswer)
  return answer.ok ? { ok: true, value: answer.value.items } : answer
}

/**
 * One linked Akahu account's Transactions from `start` to `end`, following `cursor.next` to the last page.
 *
 * `start` is EXCLUSIVE at Akahu's end, so the caller passes the instant just before the first one it wants. Both are ISO 8601.
 * A null `start` asks with no lower bound, and Akahu gives as much history as the consent and the app's history setting allow;
 * that is for an Account syncing from scratch with nothing imported to overlap (worker/sync.ts: SyncWindow).
 *
 * `budget` is how many pages this call may ask for, counted down across the whole Sync. Running out is not an error: the
 * Transactions read so far are returned with `complete: false`, so the caller can record that the Account is not up to date
 * rather than claim a success (spec 47).
 */
export async function fetchAkahuTransactions(
  tokens: AkahuTokens,
  akahuAccountId: string,
  range: { start: string | null; end: string },
  budget: { pagesLeft: number },
): Promise<AkahuResult<{ transactions: AkahuTransaction[]; complete: boolean }>> {
  const transactions: AkahuTransaction[] = []
  let cursor: string | null = null
  // Akahu's ID is opaque and goes in a path: anything but its own shape is not asked for.
  if (!/^acc_[A-Za-z0-9]{1,64}$/.test(akahuAccountId)) return failed('unreadable')
  do {
    if (budget.pagesLeft <= 0) return { ok: true, value: { transactions, complete: false } }
    budget.pagesLeft -= 1
    const query = new URLSearchParams({ end: range.end })
    if (range.start !== null) query.set('start', range.start)
    if (cursor !== null) query.set('cursor', cursor)
    const answer: AkahuResult<z.infer<typeof page>> = await get(`/accounts/${akahuAccountId}/transactions?${query}`, tokens, page)
    if (!answer.ok) return answer
    // Akahu seeing more accounts than were linked must not put them in the app (spec 31). Asking per account should make this
    // impossible; it is checked rather than trusted, because the cost of being wrong is someone's personal account in the ledger.
    transactions.push(...answer.value.items.filter((item) => item._account === akahuAccountId))
    cursor = answer.value.cursor?.next ?? null
  } while (cursor !== null)
  return { ok: true, value: { transactions, complete: true } }
}
