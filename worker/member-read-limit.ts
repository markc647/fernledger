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
//   CSV export, and a Transaction list that searches text, sorts by other than date, counts, or asks for a page from OFFSET_FROM on) reads every Transaction, or every one in its dates, one or more times. Before it runs, one statement reserves a hold sized by that and by the
//   number of Transactions (their highest ID, one row to read), and only if neither limit has been reached: a single statement is atomic,
//   so requests sent together can't all pass on the same tally, and the most a limit is passed by is about one request. Once answered, the
//   hold is settled to what the request read (CHARGE_FROM_ROWS at the least, so every dear request counts towards the limits however few
//   Transactions there are). That is two rows written a dear request, at most 2 * MEMBER_DAILY_READS / CHARGE_FROM_ROWS a day.
// - Any other request is checked and charged without a hold. Most read a few rows or a page; a few read about one pass over an Account's
//   Transactions and are not dear here (an Account's balance history, the current balances, an Account's count of imported rows; #56). Before it runs, the tally is read, and the request refused if a limit has been reached. Once answered, it is charged what it read from CHARGE_FROM_ROWS up; below that,
//   CHARGE_FROM_ROWS with the chance rows / CHARGE_FROM_ROWS, and otherwise nothing: the same on average, so many small reads reach the limit
//   as surely as a few large ones, while these charges write at most about MEMBER_DAILY_READS / CHARGE_FROM_ROWS rows a day. Requests sent
//   together can each pass the check, by that request's reads each.
// - A refused request is a 429 and writes nothing. Either way a Member's request runs two D1 queries more than the route's (one when a
//   cheap one isn't charged), of the 50 an invocation may run (ADR 0004).

/** All Members together: with the re-run's 2.5 million, this leaves 1 million for the Admin, Imports, Sync and the backup. */
export const MEMBER_DAILY_READS = 1_500_000
/** One Member, so no one Member can use up the others' share. */
export const EACH_MEMBER_DAILY_READS = 1_000_000
/** A cheap request that read fewer rows is charged this many by chance (`chargeFor`), and a dear one at least this many. */
export const CHARGE_FROM_ROWS = 1_000

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

/**
 * How many times each dear route reads a Transaction, at most (ADR 0004; member-read-limit.test.ts measures each against it). Balance history
 * (net worth, the balances Report) is about 6, measured up to 7 with Overrides and a balance check, so 8; the Loans Report reads a loan for every
 * page and again for its opening balance, about 11; the CSV export about 7 (transaction-export.test.ts), measured up to 8.3, so 9. The Transactions Report reads a page through its index, not every Transaction, so it is 0.
 */
const READS_PER_TRANSACTION: Record<string, number> = {
  '/api/charts/net-worth': 8,
  '/api/charts/spending': 4,
  '/api/reports/transactions': 0,
  '/api/reports/spending': 4,
  '/api/reports/income-vs-spending': 4,
  '/api/reports/loans': 11,
  '/api/reports/balances': 8,
  '/api/reports/budget-vs-actual': 4,
  '/api/budgets/vs-actual': 4,
  '/api/transactions/export.csv': 9,
}
/** A chart or Report not in the list is held as the dearest, so a new one is never cheap by mistake. */
const UNLISTED_READS = Math.max(...Object.values(READS_PER_TRANSACTION))

/**
 * How many times a dear request reads each Transaction, at most, and 0 for a cheap one. The query string is read as sent: the route validates
 * it afterwards, and a refused one reads nothing more.
 */
export function readsPerTransaction(path: string, params: URLSearchParams): number {
  const listed = READS_PER_TRANSACTION[path]
  if (listed !== undefined) return listed
  if (path.startsWith('/api/charts/') || path.startsWith('/api/reports/')) return UNLISTED_READS
  if (path !== '/api/transactions') return 0
  const sort = params.get('sort') ?? 'date'
  const count = params.get('count')
  const counts = count === 'true' || count === 'only' || (count === null && Number(params.get('offset') ?? 0) === 0) // as the route reads it: offset=00 is the first page
  return (sort === 'date' ? 0 : 4) + ((params.get('text') ?? '').trim() === '' ? 0 : 2) + (counts ? 1 : 0)
}

/** A Transaction list page this far in or further is dear: the list pages by OFFSET, so it reads every row it skips. */
export const OFFSET_FROM = 1_000
/** What a list page reads for each row it skips or shows: its place in the date index and the row (measured in member-read-limit.test.ts). */
const READS_PER_PAGE_ROW = 2

/**
 * The rows a Transaction list page from OFFSET_FROM on skips and shows: its offset and its page, as the route reads them (transaction-search.ts),
 * and 0 for any other request. The hold is READS_PER_PAGE_ROW for each, with the offset capped at the highest Transaction ID, since a page past
 * the last row reads them all and no more.
 */
export function pageRows(path: string, params: URLSearchParams): { rows: number; limit: number } {
  const offset = Number(params.get('offset') ?? 0)
  const limit = Math.min(Math.max(Number(params.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  return path === '/api/transactions' && offset >= OFFSET_FROM ? { rows: offset + limit, limit } : { rows: 0, limit }
}

// ?1 the UTC day, ?2 the Member's key for it.
const TODAY = `SELECT COALESCE(SUM(rows_read), 0) AS everyone, COALESCE(SUM(CASE WHEN member_key = ?2 THEN rows_read END), 0) AS mine
  FROM member_read_usage WHERE usage_day = ?1`
const CHARGE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?2, ?1, ?3)
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read`
// The hold: ?3 reads for each Transaction, and READS_PER_PAGE_ROW for each of a list page's ?7 rows skipped and shown (`pageRows`; ?8 its page),
// capped at the highest ID and a page, CHARGE_FROM_ROWS (?4) at the least. Adds it only while neither limit (?5 everyone, ?6 one Member) has been reached, and hands it
// back; no row comes back when one has.
const HIGHEST_ID = `COALESCE((SELECT MAX(id) FROM transactions), 0)`
const HOLD = `MAX(?4, ?3 * ${HIGHEST_ID} + ${READS_PER_PAGE_ROW} * MIN(?7, ${HIGHEST_ID} + ?8))`
const RESERVE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read)
  SELECT ?2, ?1, ${HOLD}
  WHERE (SELECT COALESCE(SUM(rows_read), 0) FROM member_read_usage WHERE usage_day = ?1) < ?5
    AND (SELECT COALESCE(SUM(rows_read), 0) FROM member_read_usage WHERE usage_day = ?1 AND member_key = ?2) < ?6
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read
  RETURNING ${HOLD} AS hold`
// Charges ?3 to the day the reads finished (?1, the key ?2), less the hold (?4): the hold when that is the day it was reserved on (the same
// key), and 0 when not, since a hold reserved on the day before is on that day's row, which the trigger clears, and not on this one.
const SETTLE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?2, ?1, ?3)
  ON CONFLICT (member_key) DO UPDATE SET rows_read = MAX(0, rows_read + excluded.rows_read - ?4)`

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
  const day = utcDay(new Date())
  const key = await memberKey(day, member.email)
  const params = new URL(c.req.url).searchParams
  const perTransaction = readsPerTransaction(c.req.path, params)
  const page = pageRows(c.req.path, params)
  let hold = 0
  if (perTransaction > 0 || page.rows > 0) {
    const held = await db
      .prepare(RESERVE)
      .bind(day, key, perTransaction, CHARGE_FROM_ROWS, MEMBER_DAILY_READS, EACH_MEMBER_DAILY_READS, page.rows, page.limit)
      .first<{ hold: number }>()
    if (!held) return refused()
    hold = held.hold
  } else {
    const today = await db.prepare(TODAY).bind(day, key).first<{ everyone: number; mine: number }>()
    if (today!.everyone >= MEMBER_DAILY_READS || today!.mine >= EACH_MEMBER_DAILY_READS) return refused()
  }
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
      if (hold > 0) await db.prepare(SETTLE).bind(finished, finishedKey, charge, finished === day ? hold : 0).run()
      else if (charge > 0) await db.prepare(CHARGE).bind(finished, finishedKey, charge).run()
    } catch (error) {
      logEvent('request.member-read-charge-failed', { error })
    }
  }

  function refused() {
    logEvent('request.member-read-limit')
    return c.json(MEMBER_LIMIT_REACHED, 429)
  }
})
