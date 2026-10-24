import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { requireKept } from './kept-reports'
import { balancesReportQuery, readBalancesReport } from './report-balances'
import { budgetReportQuery, readBudgetReport } from './report-budget'
import { incomeVsSpendingQuery, readIncomeVsSpending } from './report-income-vs-spending'
import { loansQuery, readLoanPage, toLoansQuery } from './report-loans'
import { readSpendingReport, spendingReportQuery } from './report-spending'
import { buildReportPage, pageOf, reportQuery, toReportQuery, type ReportRow } from './report-transactions'
import { validate } from './validate'

/**
 * The data behind the print-formatted Reports (README: Reports). The Admin reads any, which is how a Report is made (the page then keeps its choices: kept-reports.ts); a Member reads
 * only a Report the Admin has kept, so `requireKept` is in front of every route. Each is read a page at a time, so each request stays small (ADR 0004; sizes in
 * report-transactions.ts); the Report page puts the pages together.
 */
export const reports = new Hono<AppEnv>()
  .use('*', requireKept)
  .get('/transactions', validate('query', reportQuery), async (c) => {
    const query = toReportQuery(c.req.valid('query'))
    const { sql, binds } = buildReportPage(query)
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<ReportRow>()
    return c.json(pageOf(results, query.limit))
  })
  // Spending by Category over the dates, for every Account or the one named: what `GET /api/charts/spending` gives for the same dates (spending-by-category.ts), and what the Report's bar chart is drawn from. It is one
  // request however many Accounts there are, so a Report of all of them is not a request for each.
  .get('/spending', validate('query', spendingReportQuery), async (c) => {
    const { accountId, from, to } = c.req.valid('query')
    const report = await readSpendingReport(c.env.DB, { from, to, ...(accountId === undefined ? {} : { accountId: Number(accountId) }) })
    return report ? c.json(report) : c.json({ error: 'Not found' }, 404)
  })
  // Income and Spending in each month of the dates, for every Account or the one named (spending.ts's SQL, as the Spending by Category Report). One request
  // however many Accounts there are, and at most MAX_INCOME_MONTHS months.
  .get('/income-vs-spending', validate('query', incomeVsSpendingQuery), async (c) => {
    const { accountId, from, to } = c.req.valid('query')
    const report = await readIncomeVsSpending(c.env.DB, { from, to, ...(accountId === undefined ? {} : { accountId: Number(accountId) }) })
    return report ? c.json(report) : c.json({ error: 'Not found' }, 404)
  })
  // The Transactions of one Loans Category, a page at a time (report-loans.ts). One request is one Category, so a Report of all the Loans Categories is several.
  .get('/loans', validate('query', loansQuery), async (c) => {
    const page = await readLoanPage(c.env.DB, toLoansQuery(c.req.valid('query')))
    return page ? c.json(page) : c.json({ error: 'Not found' }, 404)
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
