import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { CHANGE_TYPE_IDS, CHANGE_TYPES, type ChangeLogRow } from './changelog'
import { isRealDate } from './import-rows'
import { nextDay, nzDayStart } from './nz-time'
import { validate } from './validate'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const digits = z.optional(z.string().check(z.regex(/^\d{1,9}$/)))
// Bounded so nzDayStart and nextDay never see a year they can't handle (a date input emits partial years such as 0002 while one is typed).
const MIN_DATE = '2000-01-01'
const MAX_DATE = '2100-12-31'
const nzDate = z.optional(z.string().check(z.refine((value) => isRealDate(value) && value >= MIN_DATE && value <= MAX_DATE)))

const query = z
  .object({ type: z.optional(z.enum(CHANGE_TYPE_IDS)), from: nzDate, to: nzDate, limit: digits, offset: digits })
  .check(z.refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'] }))

const TYPES = CHANGE_TYPE_IDS.map((id) => ({ id, label: CHANGE_TYPES[id] }))

/**
 * The Change Log, newest first, which every Member can read. Filters are a type and an NZ date range (both ends included);
 * a page is at most MAX_LIMIT entries so one request stays inside the free plan's budgets (ADR 0004).
 * `before` and `after` are returned as stored (JSON text); the browser lays them out field by field.
 */
export const changeLogList = new Hono<AppEnv>().get('/', validate('query', query), async (c) => {
  const q = c.req.valid('query')
  const limit = Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const offset = Number(q.offset ?? 0)
  // Entries are stored in UTC, so an NZ day is the span from its midnight to the next NZ day's midnight.
  const since = q.from ? nzDayStart(q.from) : null
  const until = q.to ? nzDayStart(nextDay(q.to)) : null
  const type = q.type ?? null

  const db = c.env.DB
  const where = 'WHERE (?1 IS NULL OR type = ?1) AND (?2 IS NULL OR at >= ?2) AND (?3 IS NULL OR at < ?3)'
  const [count, page] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total FROM change_log ${where}`).bind(type, since, until),
    // id order is time order (entries are only ever appended), so there's nothing to sort.
    db
      .prepare(`SELECT id, at, actor, type, summary, before, after FROM change_log ${where} ORDER BY id DESC LIMIT ?4 OFFSET ?5`)
      .bind(type, since, until, limit, offset),
  ])
  return c.json({ total: (count!.results[0] as { total: number }).total, entries: page!.results as ChangeLogRow[], types: TYPES })
})
