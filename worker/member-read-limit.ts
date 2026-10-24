import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './app-env'
import { sha256Hex } from './backup-format'
import { logEvent } from './log'
import { isWrite } from './request-format'
import { utcDay } from './rule-rerun'

// The Members' share of D1 Free's day (5 million rows read; ADR 0004). Every Member reads the same Transactions, and a text search, a non-date
// sort or net worth reads each one several times, so without a limit one Member's requests could use up the day for everyone, the Admin and the
// cron included. The Admin's requests are not counted: the Admin owns the deployment, and the re-run (rule-rerun.ts) keeps its own share.
//
// - Each Member GET under /api/* runs on a copy of the D1 binding that adds up the `meta.rows_read` D1 reports for each statement.
// - Once a request is answered, what it read is charged to today's tally (member_read_usage, 5001_member_read_usage.sql). A request that read
//   CHARGE_FROM_ROWS or more is charged what it read. A cheaper one is charged CHARGE_FROM_ROWS by chance, with the chance rows / CHARGE_FROM_ROWS,
//   and otherwise writes nothing: on average it is charged what it read, so many small reads reach the limit as one large one does, and the
//   tally still writes at most about MEMBER_DAILY_READS / CHARGE_FROM_ROWS rows a day. The table's trigger clears earlier days on a
//   Member's first charge of the day.
// - A Member's request runs one D1 query more than the route's, two when it is charged, of the 50 an invocation may run (ADR 0004).
// - Before a request runs, today's tally is read. Once all Members together have reached MEMBER_DAILY_READS, or this Member has reached
//   EACH_MEMBER_DAILY_READS, the request is refused with a 429 and writes nothing. A request can pass a limit by its own cost, since
//   what it reads is known only afterwards; the largest (net worth at 100,000 Transactions) is about 600,000 rows.
// - The day is the UTC day, when D1's allowance resets (about midday in New Zealand).

/** All Members together: with the re-run's 2.5 million, this leaves 1 million for the Admin, Imports, Sync and the backup. */
export const MEMBER_DAILY_READS = 1_500_000
/** One Member, so no one Member can use up the others' share. */
export const EACH_MEMBER_DAILY_READS = 1_000_000
/** A request that read fewer rows is charged this many by chance (`chargeFor`). */
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

const TODAY = `SELECT COALESCE(SUM(rows_read), 0) AS everyone, COALESCE(SUM(CASE WHEN member_key = ?2 THEN rows_read END), 0) AS mine
  FROM member_read_usage WHERE usage_day = ?1`
const CHARGE = `INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?2, ?1, ?3)
  ON CONFLICT (member_key) DO UPDATE SET rows_read = rows_read + excluded.rows_read`

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

/** Counts a Member's reads, refuses them past the limits, and charges each request what `chargeFor` says. */
export const memberReadLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { member } = c.var
  if (member.role === 'admin' || isWrite(c.req.method) || UNCOUNTED.has(c.req.path)) return next()
  const db = c.env.DB
  const day = utcDay(new Date())
  const key = await memberKey(day, member.email)
  const today = await db.prepare(TODAY).bind(day, key).first<{ everyone: number; mine: number }>()
  if (today!.everyone >= MEMBER_DAILY_READS || today!.mine >= EACH_MEMBER_DAILY_READS) {
    logEvent('request.member-read-limit', { count: today!.mine })
    return c.json(MEMBER_LIMIT_REACHED, 429)
  }
  const tally = { rows: 0 }
  c.env = { ...c.env, DB: countingReads(db, tally) }
  await next()
  const charge = chargeFor(tally.rows)
  if (charge === 0) return
  // The answer is already made: a charge that fails (D1's daily writes gone, say) is logged rather than turned into an error for a read that worked.
  try {
    await db.prepare(CHARGE).bind(day, key, charge).run()
  } catch (error) {
    logEvent('request.member-read-charge-failed', { error })
  }
})
