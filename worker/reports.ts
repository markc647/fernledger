import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { buildReportPage, pageOf, reportQuery, toReportQuery, type ReportRow } from './report-transactions'
import { validate } from './validate'

/**
 * The data behind the print-formatted Reports (README: Reports). Every Member can read them. Each is read a page at a time,
 * so each request stays small (ADR 0004; sizes in report-transactions.ts); the Report page puts the pages together.
 */
export const reports = new Hono<AppEnv>().get('/transactions', validate('query', reportQuery), async (c) => {
  const query = toReportQuery(c.req.valid('query'))
  const { sql, binds } = buildReportPage(query)
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<ReportRow>()
  return c.json(pageOf(results, query.limit))
})
