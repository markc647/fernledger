import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { balancesReportQuery, readBalancesReport } from './report-balances'
import { budgetReportQuery, readBudgetReport } from './report-budget'
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
  // Balances over time for one Account: its balance history (worker/balances.ts) at the end of each month. One request is one
  // Account, so a Report of several Accounts is several small requests.
  .get('/balances', validate('query', balancesReportQuery), async (c) => {
    const { accountId, from, to } = c.req.valid('query')
    const report = await readBalancesReport(c.env.DB, { accountId: Number(accountId), from, to })
    return report ? c.json(report) : c.json({ error: 'Not found' }, 404)
  })
  // Each Spending Category's Budget against what it spent, for every NZ month the dates touch (worker/report-budget.ts). A Budget is for all Accounts
  // together, so this takes no Account. One request whatever the months, at most MAX_REPORT_MONTHS of them.
  .get('/budget-vs-actual', validate('query', budgetReportQuery), async (c) => c.json(await readBudgetReport(c.env.DB, c.req.valid('query'))))
