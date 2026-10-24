import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { rangeOf, spendingQuery } from './chart-spending'
import { isKept, NOT_KEPT } from './kept-reports'
import { DEFAULT_NET_WORTH_RANGE, netWorthQuery, readNetWorth } from './net-worth'
import { readSpendingByCategory } from './spending-by-category'
import { validate } from './validate'

// The numbers behind the charts. Read-only, so every Member can use net worth (spending is gated, below); the guard in app.ts already refuses a change from anyone but the Admin. Net worth is balance history added up
// (net-worth.ts) and is the Net worth page's. Spending is spending.ts's (spending-by-category.ts), and no page asks for it here now: the Spending by Category Report's chart is drawn from
// the Report's own answer. The route stays for the moment, because the Reports' tests hold their figures to it.
export const charts = new Hono<AppEnv>()
  // The tracked Accounts' balances added up at the end of each month, for the range asked for (the last 24 months when none is).
  .get('/net-worth', validate('query', netWorthQuery), async (c) => c.json(await readNetWorth(c.env.DB, c.req.valid('query').range ?? DEFAULT_NET_WORTH_RANGE, new Date())))
  // Spending by Category for a named period or two dates, Transfers left out. No page calls it (see above). It is the Spending by Category Report of every Account,
  // so a Member reads it only for the dates of one the Admin has kept, as for GET /api/reports/spending (kept-reports.ts).
  .get('/spending', validate('query', spendingQuery), async (c) => {
    const range = rangeOf(c.req.valid('query'), new Date())
    if (c.var.member.role !== 'admin' && !(await isKept(c.env.DB, 'spending', { accountId: null, categoryId: null, ...range }))) return c.json(NOT_KEPT, 403)
    return c.json(await readSpendingByCategory(c.env.DB, range))
  })
