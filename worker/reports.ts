import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { balancesReportQuery, readBalancesReport } from './report-balances'
import { readSpendingReport, spendingReportQuery } from './report-spending'
import { buildReportPage, pageOf, reportQuery, toReportQuery, type ReportRow } from './report-transactions'
import { validate } from './validate'

/**
 * The data behind the print-formatted Reports (README: Reports). Every Member can read them. Each is read a page at a time,
 * so each request stays small (ADR 0004; sizes in report-transactions.ts); the Report page puts the pages together.
 */
export const reports = new Hono<AppEnv>()
  .get('/transactions', validate('query', reportQuery), async (c) => {
    const query = toReportQuery(c.req.valid('query'))
    const { sql, binds } = buildReportPage(query)
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<ReportRow>()
    return c.json(pageOf(results, query.limit))
  })
  // Spending by Category over the dates, for every Account or the one named (spending.ts is the only place spending is worked out). It is one
  // request however many Accounts there are, so a Report of all of them is not a request for each.
  .get('/spending', validate('query', spendingReportQuery), async (c) => {
    const { accountId, from, to } = c.req.valid('query')
    const report = await readSpendingReport(c.env.DB, { accountId: accountId === undefined ? undefined : Number(accountId), from, to })
    return report ? c.json(report) : c.json({ error: 'Not found' }, 404)
  })
  // Balances over time for one Account: its balance history (worker/balances.ts) at the end of each month. One request is one
  // Account, so a Report of several Accounts is several small requests.
  .get('/balances', validate('query', balancesReportQuery), async (c) => {
    const { accountId, from, to } = c.req.valid('query')
    const report = await readBalancesReport(c.env.DB, { accountId: Number(accountId), from, to })
    return report ? c.json(report) : c.json({ error: 'Not found' }, 404)
  })
