import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './app-env'
import { sha256Hex } from './backup-format'
import { logEvent } from './log'
import { isWrite } from './request-format'
import { utcDay } from './rule-rerun'
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
//   never settles (cancelled, say) is taken as spent after HOLD_EXPIRY_MS: the next reservation charges it, and it stops counting as in flight.
// - A hold reserved before 00:00 UTC stays on its own day's row, which 5002_member_read_holds.sql keeps while the hold is young, and the new
//   day's admission counts it. Its settling charges the new day, the day its reads finished, and releases the hold from the day before.
// - Any other request is checked and charged without a hold, and is not leased. It reads a few rows or a page. Before it runs, the tally and
//   the holds in flight are read, and the request refused if a limit has been reached. Once answered, it is charged what it read from CHARGE_FROM_ROWS up; below that,
//   CHARGE_FROM_ROWS with the chance rows / CHARGE_FROM_ROWS, and otherwise nothing: the same on average, so many small reads reach the limit
//   as surely as a few large ones, while these charges write at most about MEMBER_DAILY_READS / CHARGE_FROM_ROWS rows a day. Requests sent
//   together can each pass the check, by a page each.
// - A refused request is a 429 and writes nothing. Either way a Member's request runs two D1 queries more than the route's (one when a
//   cheap one isn't charged; a refused dear one runs one more to say why, and none of the route's), of the 50 an invocation may run (ADR 0004).

/** All Members together: with the re-run's 2.5 million, this leaves 1 million for the Admin, Imports, Sync and the backup. */
export const MEMBER_DAILY_READS = 1_500_000
/** One Member, so no one Member can use up the others' share. */
export const EACH_MEMBER_DAILY_READS = 1_000_000
/** A cheap request that read fewer rows is charged this many by chance (`chargeFor`), and a dear one at least this many. */
export const CHARGE_FROM_ROWS = 1_000
/** A Member's dear requests in flight at once: enough for a page's own requests sent together (the balances Report's, one for each Account, wait their turn). */
export const MEMBER_MAX_IN_FLIGHT = 4
/** A hold this old whose request has not settled is taken as spent: no request a Member makes runs for a minute. 5002_member_read_holds.sql has the same figure. */
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
// day's reads and every hold reserved on it, and the day before's holds while they are young (in flight across 00:00 UTC). `in_flight` is
// the Member's young holds, on either day.
const YOUNG = `held_at >= ?4 - ${HOLD_EXPIRY_MS}`
const COUNTED = `CASE WHEN usage_day = ?1 THEN rows_read + held WHEN ${YOUNG} THEN held ELSE 0 END`
const EVERYONE = `(SELECT COALESCE(SUM(${COUNTED}), 0) FROM member_read_usage)`
const MINE = `(SELECT COALESCE(SUM(${COUNTED}), 0) FROM member_read_usage WHERE member_key IN (?2, ?3))`
const IN_FLIGHT = `(SELECT COALESCE(SUM(CASE WHEN ${YOUNG} THEN held_count ELSE 0 END), 0) FROM member_read_usage WHERE member_key IN (?2, ?3))`
const STATE = `SELECT ${EVERYONE} AS everyone, ${MINE} AS mine, ${IN_FLIGHT} AS in_flight`
// A cheap request's charge: ?3 to the day its reads finished (?1, the key ?2).
const CHARGE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?2, ?1, ?3)
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read`
// The hold: ?5 reads for each Transaction and ?11 for each Change Log entry, and READS_PER_PAGE_ROW for each of a list page's ?6 rows
// skipped and shown (`pageRows`; ?7 its page), capped at the highest ID and a page, CHARGE_FROM_ROWS (?8) at the least. Added only while
// neither limit (?9 everyone, ?10 one Member) has been reached and fewer than ?12 of the Member's holds are in flight, and handed back; no
// row comes back otherwise. Holds on the row older than HOLD_EXPIRY_MS are charged as spent first. SET reads the row as it was.
const HIGHEST_ID = `COALESCE((SELECT MAX(id) FROM transactions), 0)`
const HIGHEST_ENTRY = `COALESCE((SELECT MAX(id) FROM change_log), 0)`
const HOLD = `MAX(?8, ?5 * ${HIGHEST_ID} + ?11 * ${HIGHEST_ENTRY} + ${READS_PER_PAGE_ROW} * MIN(?6, ${HIGHEST_ID} + ?7))`
const STALE = `held_at < ?4 - ${HOLD_EXPIRY_MS}`
const RESERVE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count, held_at)
  SELECT ?2, ?1, 0, ${HOLD}, 1, ?4
  WHERE ${EVERYONE} < ?9 AND ${MINE} < ?10 AND ${IN_FLIGHT} < ?12
  ON CONFLICT (member_key) DO UPDATE SET
    rows_read = rows_read + CASE WHEN ${STALE} THEN held ELSE 0 END,
    held = CASE WHEN ${STALE} THEN 0 ELSE held END + excluded.held,
    held_count = CASE WHEN ${STALE} THEN 0 ELSE held_count END + 1,
    held_at = ?4
  RETURNING ${HOLD} AS hold`
// Settling on the day it was reserved: ?3 charged and the hold ?4 released, on the key ?2.
const SETTLE = `UPDATE member_read_usage SET rows_read = rows_read + ?3, held = MAX(0, held - ?4), held_count = MAX(0, held_count - 1) WHERE member_key = ?2`
// Settling on a later day: ?3 charged to the day the reads finished (?1, the key ?2), and the hold ?4 released from the row it was reserved on
// (the key ?5), if that is still there, in one statement. SET reads the row as it was, and `excluded` is the row each SELECT gives.
const SETTLE_LATER = `INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count)
  SELECT ?2, ?1, ?3, 0, 0
  UNION ALL SELECT member_key, usage_day, 0, -?4, -1 FROM member_read_usage WHERE member_key = ?5
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read, held = MAX(0, held + excluded.held), held_count = MAX(0, held_count + excluded.held_count)`

/** A Member's key for a day: no email is stored, and yesterday's key says nothing about today's. */
export const memberKey = (day: string, email: string) => sha256Hex(new TextEncoder().encode(`${day}\n${email}`))

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

/** Counts a Member's reads, refuses them past the limits, and charges them: a dear request by a hold settled afterwards, a cheap one by `chargeFor`. */
export const memberReadLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { member } = c.var
  if (member.role === 'admin' || isWrite(c.req.method) || UNCOUNTED.has(c.req.path)) return next()
  const db = c.env.DB
  const now = Date.now()
  const day = utcDay(new Date(now))
  const key = await memberKey(day, member.email)
  const dayBefore = await memberKey(utcDay(new Date(now - 86_400_000)), member.email)
  const params = new URL(c.req.url).searchParams
  const reads = dearReads(c.req.path, params)
  const page = pageRows(c.req.path, params)
  const state = () => db.prepare(STATE).bind(day, key, dayBefore, now).first<{ everyone: number; mine: number; in_flight: number }>()
  const overLimit = (s: { everyone: number; mine: number }) => s.everyone >= MEMBER_DAILY_READS || s.mine >= EACH_MEMBER_DAILY_READS
  let hold = 0
  if (reads.perTransaction > 0 || reads.perEntry > 0 || page.rows > 0) {
    const held = await db
      .prepare(RESERVE)
      .bind(day, key, dayBefore, now, reads.perTransaction, page.rows, page.limit, CHARGE_FROM_ROWS, MEMBER_DAILY_READS, EACH_MEMBER_DAILY_READS, reads.perEntry, MEMBER_MAX_IN_FLIGHT)
      .first<{ hold: number }>()
    if (!held) return overLimit((await state())!) ? refused() : busy()
    hold = held.hold
  } else if (overLimit((await state())!)) return refused()
  const tally = { rows: 0 }
  c.env = { ...c.env, DB: countingReads(db, tally) }
  try {
    await next()
  } finally {
    // The answer is already made: a charge that fails (D1's daily writes gone, say) is logged rather than turned into an error for a read that
    // worked. A dear request's hold then stays charged, so the limits still hold.
    const finished = utcDay(new Date())
    const finishedKey = finished === day ? key : await memberKey(finished, member.email)
    const charge = hold > 0 ? Math.max(tally.rows, CHARGE_FROM_ROWS) : chargeFor(tally.rows)
    try {
      if (hold > 0 && finished === day) await db.prepare(SETTLE).bind(finished, key, charge, hold).run()
      else if (hold > 0) await db.prepare(SETTLE_LATER).bind(finished, finishedKey, charge, hold, key).run()
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
