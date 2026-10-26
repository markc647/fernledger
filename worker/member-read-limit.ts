import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './app-env'
import { sha256Hex, toHex } from './backup-format'
import { utcDay } from './dates'
import { logEvent } from './log'
import { isWrite } from './request-format'
import { PAID_PLAN } from './settings'
import { DEFAULT_LIMIT, MAX_LIMIT } from './transaction-search'

// The Members' share of D1 Free's day (5 million rows read; ADR 0004). Every Member reads the same Transactions, and a text search, a non-date
// sort or net worth reads each one several times, so without a limit one Member's requests could use up the day for everyone, the Admin and the
// cron included. The Admin's requests are not counted: the Admin owns the deployment, and the re-run (rule-rerun.ts) keeps its own share.
//
// - Each Member GET under /api/* runs on a copy of the D1 binding that adds up the `meta.rows_read` D1 reports for each statement, and is
//   charged to the tally (member_read_usage, 5001_member_read_usage.sql) of the UTC day its reads finished. The table's trigger clears
//   earlier days on a Member's first row of the day.
// - A dear request (`readsPerTransaction`: net worth and the other charts, the Reports but the Transactions Report, Budget vs actual, the
//   CSV export, and a Transaction list that searches text, sorts by other than date, counts, filters by Category or Transfer, or asks for a
//   page from OFFSET_FROM on), and the whole-Account routes and the Change Log, reads every Transaction (or Change Log entry), or every one in
//   its dates, one or more times, or the rows it skips. Before it runs, one statement reserves a hold sized by that and by the number of
//   Transactions and entries (their highest IDs), and only if neither limit has been reached, counting the holds still in flight, and while
//   fewer than MEMBER_MAX_IN_FLIGHT of the Member's own are (a lease). A single statement is atomic, so requests sent together can't all
//   pass on the same tally: a limit is passed by about one request, or by at most MEMBER_MAX_IN_FLIGHT requests' shortfall if their holds
//   are short of what they read. Once answered, the hold is settled to what the request read (CHARGE_FROM_ROWS at the least, so every dear
//   request counts towards the limits however few rows there are). That is two rows written a dear request, three across 00:00 UTC.
// - A request past the lease is a 429 `member-busy`, which the browser tries again shortly (src/lib/member-busy.ts). A hold whose request
//   never settles (cancelled, say) is taken as spent once the oldest of the row's holds is HOLD_EXPIRY_MS old: the next reservation charges
//   them all and starts again, so they stop counting as in flight however busy the Member is. A request that then settles finds it was
//   (the row's `held_at`, when its holds began, is no longer the one it reserved under) and corrects its charge from its hold to its reads.
// - A hold reserved before 00:00 UTC stays on its own day's row, which 5002_member_read_holds.sql keeps while the hold is young, and the new
//   day's admission counts it. Its settling charges the new day, the day its reads finished, and releases the hold from the day before.
// - Any other request is checked and charged without a hold, and is not leased. It reads a few rows or a page. Before it runs, the tally and
//   the holds in flight are read, and the request refused if a limit has been reached. Once answered, it is charged what it read from CHARGE_FROM_ROWS up; below that,
//   CHARGE_FROM_ROWS with the chance rows / CHARGE_FROM_ROWS, and otherwise nothing: the same on average, so many small reads reach the limit
//   as surely as a few large ones, while these charges write at most about MEMBER_DAILY_READS / CHARGE_FROM_ROWS rows a day. Requests sent
//   together can each pass the check, by a page each.
// - A refused request is a 429 and writes nothing. Either way a Member's request runs two D1 queries more than the route's (one when a
//   cheap one isn't charged; a refused dear one runs one more to say why, and none of the route's), of the 50 an invocation may run (ADR 0004).

/** The D1 queries the limit adds to a Member's dear request: its hold and its settling. */
export const MEMBER_LIMIT_QUERIES = 2

/** All Members together: with the re-run's 2.5 million, this leaves 1 million for the Admin, Imports, Sync and the backup. */
export const MEMBER_DAILY_READS = 1_500_000
/** One Member, so no one Member can use up the others' share. */
export const EACH_MEMBER_DAILY_READS = 1_000_000
/** A cheap request that read fewer rows is charged this many by chance (`chargeFor`), and a dear one at least this many. */
export const CHARGE_FROM_ROWS = 1_000
/** A Member's dear requests in flight at once: enough for a page's own requests sent together (the balances Report's, one for each Account, wait their turn). */
export const MEMBER_MAX_IN_FLIGHT = 4
/** Holds whose requests began this long ago and have not settled are taken as spent: no request a Member makes runs for a minute. 5002_member_read_holds.sql has the same figure (a test holds them together). */
export const HOLD_EXPIRY_MS = 60_000

/**
 * What a request that read `rows` is charged: `rows` from CHARGE_FROM_ROWS up; below it, CHARGE_FROM_ROWS with the chance rows / CHARGE_FROM_ROWS
 * and otherwise 0, so the charge is `rows` on average. The draw is crypto.getRandomValues, as a Member can't predict it.
 */
export function chargeFor(rows: number): number {
  if (rows >= CHARGE_FROM_ROWS) return rows
  const [draw] = crypto.getRandomValues(new Uint32Array(1))
  return draw! < (rows / CHARGE_FROM_ROWS) * 2 ** 32 ? CHARGE_FROM_ROWS : 0
}

/** The reads that draw every page, so a Member over the limit still sees a page that says so. Each is a few rows. */
const UNCOUNTED = new Set(['/api/me', '/api/settings', '/api/features'])

export const MEMBER_LIMIT_REACHED = { error: 'Daily limit reached', reason: 'member-reads' } as const
export const MEMBER_BUSY = { error: 'Too many requests at once', reason: 'member-busy' } as const

/**
 * How many times each dear route reads a Transaction, at most. member-read-limit.test.ts measures each on Transactions with every join a row
 * can make populated (a Rule's Category, an Override, a Transfer pair, a balance check long before), since each join is a read a row; the
 * figures here are about 1.3 to 1.5 times what it measured (in brackets), so a richer history still fits. The Loans Report reads a loan for
 * every page and again for its opening balance (ADR 0004). The Transactions Report reads a page through its index, not every Transaction.
 */
const READS_PER_TRANSACTION: Record<string, number> = {
  '/api/charts/net-worth': 10, // (7.3)
  '/api/charts/spending': 5, // (3.3)
  '/api/reports/transactions': 0,
  '/api/reports/spending': 5, // (3.3)
  '/api/reports/income-vs-spending': 5, // (3.3)
  '/api/reports/loans': 11, // (3.5 for a loan of half the Transactions; ADR 0004's 10.6 for one paged)
  '/api/reports/balances': 9, // (6.4)
  '/api/reports/budget-vs-actual': 5, // (3.4)
  '/api/budgets/vs-actual': 4, // (0.3 for a month)
  '/api/transactions/export.csv': 12, // (8.8)
  // The current balances: each Account's Transactions from its anchor on, all of them when the anchor is old.
  '/api/balances': 2, // (1.0)
}
/** Routes with an ID in the path, which read about one pass over an Account's Transactions or more, as READS_PER_TRANSACTION. */
const READS_PER_TRANSACTION_BY_PATTERN: Array<[RegExp, number]> = [
  [/^\/api\/balances\/[^/]+\/history$/, 7], // the Account's balance history (4.8)
  [/^\/api\/imports\/imported\/[^/]+$/, 2], // the Account's count of imported rows (0.9)
]
/** A Transaction list's parts, as READS_PER_TRANSACTION: a sort by other than date (4.9), text to find (TEXT), a count (1.0), a Category, Uncategorised or Transfer filter that few match (3.4). */
const LIST_SORT = 7
const LIST_TEXT = 3
const LIST_COUNT = 2
const LIST_FILTER = 5
/** A chart or Report not in the list is held as the dearest, so a new one is never cheap by mistake. */
const UNLISTED_READS = Math.max(...Object.values(READS_PER_TRANSACTION))
/** The Change Log's list reads each entry about twice (its count and its page), so it is held by the Change Log's size. */
const CHANGE_LOG_READS = 3

/** What a dear request is held by: its reads for each Transaction and for each Change Log entry. Both 0 is a cheap request. */
export const dearReads = (path: string, params: URLSearchParams) => ({
  perTransaction: readsPerTransaction(path, params),
  perEntry: path === '/api/change-log' ? CHANGE_LOG_READS : 0,
})

/**
 * How many times a dear request reads each Transaction, at most, and 0 for a cheap one. The query string is read as sent: the route validates
 * it afterwards, and a refused one reads nothing more.
 */
export function readsPerTransaction(path: string, params: URLSearchParams): number {
  const listed = READS_PER_TRANSACTION[path] ?? READS_PER_TRANSACTION_BY_PATTERN.find(([pattern]) => pattern.test(path))?.[1]
  if (listed !== undefined) return listed
  if (path.startsWith('/api/charts/') || path.startsWith('/api/reports/')) return UNLISTED_READS
  if (path !== '/api/transactions') return 0
  const sort = params.get('sort') ?? 'date'
  const count = params.get('count')
  const counts = count === 'true' || count === 'only' || (count === null && (pagingNumber(params, 'offset') ?? 0) === 0) // offset=00 is the first page
  // A Category, Uncategorised or Transfer filter is tested on each row the date index passes, until a page of matches is found: when few
  // match, that is every Transaction, with its Category joins (transaction-search.ts `paging`).
  const filtered = ['categoryId', 'uncategorised', 'transfers'].some((name) => params.has(name))
  return (sort === 'date' ? 0 : LIST_SORT) + ((params.get('text') ?? '').trim() === '' ? 0 : LIST_TEXT) + (counts ? LIST_COUNT : 0) + (filtered ? LIST_FILTER : 0)
}

/** A paging number as the route reads it (transaction-search.ts `digits`): up to nine digits, or nothing when it is absent or one the route refuses. */
function pagingNumber(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name)
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined
}

/** A Transaction list page this far in or further is dear: the list pages by OFFSET, so it reads every row it skips. */
export const OFFSET_FROM = 1_000
/**
 * What a list page reads for each row it skips or shows: its place in the date index, the row, and its joins (its Account, a row for each
 * Category slot, a Transfer's partner), since OFFSET joins the rows it skips too. Measured at 3.9 with every join populated, and about 6 on
 * audit run 4's denser history, so 7.
 */
const READS_PER_PAGE_ROW = 7

/**
 * The rows a Transaction list page from OFFSET_FROM on skips and shows: its offset and its page, as the route reads them (transaction-search.ts),
 * and 0 for any other request. The hold is READS_PER_PAGE_ROW for each, with the offset capped at the highest Transaction ID, since a page past
 * the last row reads them all and no more.
 */
export function pageRows(path: string, params: URLSearchParams): { rows: number; limit: number } {
  const offset = pagingNumber(params, 'offset') ?? 0
  const limit = Math.min(Math.max(pagingNumber(params, 'limit') ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  return path === '/api/transactions' && offset >= OFFSET_FROM ? { rows: offset + limit, limit } : { rows: 0, limit }
}

// What counts towards the limits now, for ?1 the UTC day, ?2 the Member's key for it, ?3 their key for the day before, ?4 the time (ms): the
// day's reads and every hold reserved on it, and the day before's holds while they are young (in flight across 00:00 UTC). `IN_FLIGHT` is
// the Member's young holds, on either day. A row's holds are young while the oldest of them, `held_at`, is.
const YOUNG = `held_at >= ?4 - ${HOLD_EXPIRY_MS}`
const COUNTED = `CASE WHEN usage_day = ?1 THEN rows_read + held WHEN ${YOUNG} THEN held ELSE 0 END`
const EVERYONE = `(SELECT COALESCE(SUM(${COUNTED}), 0) FROM member_read_usage)`
const MINE = `(SELECT COALESCE(SUM(${COUNTED}), 0) FROM member_read_usage WHERE member_key IN (?2, ?3))`
const IN_FLIGHT = `(SELECT COALESCE(SUM(CASE WHEN ${YOUNG} THEN held_count ELSE 0 END), 0) FROM member_read_usage WHERE member_key IN (?2, ?3))`
// `paid`: the Admin has said the account is on the Paid plan, which has no daily allowance to protect, so Members' reads are neither counted nor limited.
const STATE = `SELECT ${EVERYONE} AS everyone, ${MINE} AS mine, ${PAID_PLAN} AS paid`
// A cheap request's charge: ?3 to the day its reads finished (?1, the key ?2).
const CHARGE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?2, ?1, ?3)
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read`
// The hold: ?5 reads for each Transaction and ?11 for each Change Log entry, and READS_PER_PAGE_ROW for each of a list page's ?6 rows
// skipped and shown (`pageRows`; ?7 its page), capped at the highest ID and a page, CHARGE_FROM_ROWS (?8) at the least. Added only while
// neither limit (?9 everyone, ?10 one Member) has been reached and fewer than ?12 of the Member's holds are in flight, and not on the Paid
// plan (nothing is held then, and STATE says why), and handed back with
// `held_at`, which its settling names; no row comes back otherwise. A row with no holds, or whose holds began HOLD_EXPIRY_MS ago, starts
// again at this one: what it held is charged as spent. SET reads the row as it was, and RETURNING the row as it is now.
const HIGHEST_ID = `COALESCE((SELECT MAX(id) FROM transactions), 0)`
const HIGHEST_ENTRY = `COALESCE((SELECT MAX(id) FROM change_log), 0)`
const HOLD = `MAX(?8, ?5 * ${HIGHEST_ID} + ?11 * ${HIGHEST_ENTRY} + ${READS_PER_PAGE_ROW} * MIN(?6, ${HIGHEST_ID} + ?7))`
const STARTS_AGAIN = `(held_count = 0 OR held_at IS NULL OR held_at < ?4 - ${HOLD_EXPIRY_MS})`
const RESERVE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count, held_at)
  SELECT ?2, ?1, 0, ${HOLD}, 1, ?4
  WHERE NOT ${PAID_PLAN} AND ${EVERYONE} < ?9 AND ${MINE} < ?10 AND ${IN_FLIGHT} < ?12
  ON CONFLICT (member_key) DO UPDATE SET
    rows_read = rows_read + CASE WHEN ${STARTS_AGAIN} THEN held ELSE 0 END,
    held = CASE WHEN ${STARTS_AGAIN} THEN 0 ELSE held END + excluded.held,
    held_count = CASE WHEN ${STARTS_AGAIN} THEN 0 ELSE held_count END + 1,
    held_at = CASE WHEN ${STARTS_AGAIN} THEN ?4 ELSE held_at END
  RETURNING ${HOLD} AS hold, held_at AS began`
// Settling on the day it was reserved, on the key ?1: ?2 charged and the hold ?3 released, if the row's holds are still the ones that began
// at ?4. If they started again since, the hold was charged as spent, so the charge is corrected from it (?3) to what was read (?2).
const STILL_HELD = `held_at = ?4`
const SETTLE = `UPDATE member_read_usage SET
    rows_read = MAX(0, rows_read + ?2 - CASE WHEN ${STILL_HELD} THEN 0 ELSE ?3 END),
    held = CASE WHEN ${STILL_HELD} THEN MAX(0, held - ?3) ELSE held END,
    held_count = CASE WHEN ${STILL_HELD} THEN MAX(0, held_count - 1) ELSE held_count END
  WHERE member_key = ?1`
// Settling on a later day, in one statement: the hold ?4 released from the row it was reserved on (the key ?5; its charge corrected, as
// SETTLE does, if its holds started again since ?6), if that is still there, and then ?3 charged to the day the reads finished (?1, the
// key ?2). The day before's row comes first, so a first row of the new day, whose trigger clears earlier days, can't clear it before.
// SET reads the row as it was, and `excluded` is the row each SELECT gives.
const SETTLE_LATER = `INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count)
  SELECT member_key, usage_day, CASE WHEN held_at = ?6 THEN 0 ELSE -?4 END, CASE WHEN held_at = ?6 THEN -?4 ELSE 0 END, CASE WHEN held_at = ?6 THEN -1 ELSE 0 END
    FROM member_read_usage WHERE member_key = ?5
  UNION ALL SELECT ?2, ?1, ?3, 0, 0
  ON CONFLICT (member_key) DO UPDATE SET
    rows_read = MAX(0, rows_read + excluded.rows_read), held = MAX(0, held + excluded.held), held_count = MAX(0, held_count + excluded.held_count)`

/**
 * A Member's key for a day: no email is stored, and yesterday's key says nothing about today's. It is an HMAC keyed by the Worker secret
 * MEMBER_KEY_SECRET, which `npm run deploy` sets and no backup holds, so a backup's rows can't be linked to a Member by trying the household's
 * few emails. Without the secret it is the plain hash, which can be, and Settings says Setup needed (worker/features.ts MEMBER_KEY).
 */
export async function memberKey(day: string, email: string, secret?: string) {
  const text = new TextEncoder().encode(`${day}\n${email}`)
  if (!secret) return sha256Hex(text)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, text)))
}

/**
 * The binding with every statement's `meta.rows_read` added to `tally.rows`. `first` and `raw` don't give D1's meta, so they run as `all`.
 * `exec`, `dump` and sessions are left out: no read route uses them, and a new one fails here rather than going uncounted.
 */
export function countingReads(db: D1Database, tally: { rows: number }): D1Database {
  const count = <T extends D1Response>(result: T) => {
    tally.rows += result.meta.rows_read ?? 0
    return result
  }
  const real = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const rows = async () => count(await statement.all<Record<string, unknown>>()).results
    const counted = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => count(await statement.all()),
      run: async () => count(await statement.run()),
      first: async (column?: string) => {
        const row = (await rows())[0]
        return row === undefined ? null : column === undefined ? row : row[column]
      },
      raw: async (options?: { columnNames?: boolean }) => {
        const results = await rows()
        const values = results.map((row) => Object.values(row))
        return options?.columnNames ? [Object.keys(results[0] ?? {}), ...values] : values
      },
    } as unknown as D1PreparedStatement
    real.set(counted, statement)
    return counted
  }
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => (await db.batch(statements.map((s) => real.get(s) ?? s))).map(count),
  } as unknown as D1Database
}

/**
 * Counts a Member's reads, refuses them past the limits, and charges them: a dear request by a hold settled afterwards, a cheap one by `chargeFor`.
 * On the Paid plan (`PAID_PLAN`) it lets them through uncounted, having learnt so in the queries it makes anyway, and writes nothing.
 */
export const memberReadLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { member } = c.var
  if (member.role === 'admin' || isWrite(c.req.method) || UNCOUNTED.has(c.req.path)) return next()
  const db = c.env.DB
  const now = Date.now()
  const day = utcDay(new Date(now))
  const secret = c.env.MEMBER_KEY_SECRET?.trim()
  const key = await memberKey(day, member.email, secret)
  const dayBefore = await memberKey(utcDay(new Date(now - 86_400_000)), member.email, secret)
  const params = new URL(c.req.url).searchParams
  const reads = dearReads(c.req.path, params)
  const page = pageRows(c.req.path, params)
  const state = async () => (await db.prepare(STATE).bind(day, key, dayBefore, now).first<{ everyone: number; mine: number; paid: number }>())!
  const overLimit = (s: { everyone: number; mine: number }) => s.everyone >= MEMBER_DAILY_READS || s.mine >= EACH_MEMBER_DAILY_READS
  let hold = 0
  let began = 0
  if (reads.perTransaction > 0 || reads.perEntry > 0 || page.rows > 0) {
    const held = await db
      .prepare(RESERVE)
      .bind(day, key, dayBefore, now, reads.perTransaction, page.rows, page.limit, CHARGE_FROM_ROWS, MEMBER_DAILY_READS, EACH_MEMBER_DAILY_READS, reads.perEntry, MEMBER_MAX_IN_FLIGHT)
      .first<{ hold: number; began: number }>()
    if (!held) {
      const s = await state()
      if (s.paid) return next() // on the Paid plan nothing is held or charged: the second query a dear request makes, as settling is on Free
      return overLimit(s) ? refused() : busy()
    }
    ;({ hold, began } = held)
  } else {
    const s = await state()
    if (s.paid) return next()
    if (overLimit(s)) return refused()
  }
  const tally = { rows: 0 }
  c.env = { ...c.env, DB: countingReads(db, tally) }
  try {
    await next()
  } finally {
    // The answer is already made: a charge that fails (D1's daily writes gone, say) is logged rather than turned into an error for a read that
    // worked. A dear request's hold then stays charged, so the limits still hold.
    const finished = utcDay(new Date())
    const finishedKey = finished === day ? key : await memberKey(finished, member.email, secret)
    const charge = hold > 0 ? Math.max(tally.rows, CHARGE_FROM_ROWS) : chargeFor(tally.rows)
    try {
      if (hold > 0 && finished === day) await db.prepare(SETTLE).bind(key, charge, hold, began).run()
      else if (hold > 0) await db.prepare(SETTLE_LATER).bind(finished, finishedKey, charge, hold, key, began).run()
      else if (charge > 0) await db.prepare(CHARGE).bind(finished, finishedKey, charge).run()
    } catch (error) {
      logEvent('request.member-read-charge-failed', { error })
    }
  }

  function refused() {
    logEvent('request.member-read-limit')
    return c.json(MEMBER_LIMIT_REACHED, 429)
  }
  function busy() {
    logEvent('request.member-read-busy')
    return c.json(MEMBER_BUSY, 429)
  }
})
