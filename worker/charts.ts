import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { rangeOf, spendingQuery } from './chart-spending'
import { DEFAULT_NET_WORTH_RANGE, netWorthQuery, readNetWorth } from './net-worth'
import { readSpendingByCategory } from './spending-by-category'
import { validate } from './validate'

// The numbers behind the charts. Read-only, so every Member can use them; the guard in app.ts already refuses a change from anyone but the Admin. Net worth is balance history added up
// (net-worth.ts) and is the Net worth page's. Spending is spending.ts's (spending-by-category.ts), and no page asks for it here now: the Spending by Category Report's chart is drawn from
// the Report's own answer. The route stays for the moment, because the Reports' tests hold their figures to it.
export const charts = new Hono<AppEnv>()
  // The tracked Accounts' balances added up at the end of each month, for the range asked for (the last 24 months when none is).
  .get('/net-worth', validate('query', netWorthQuery), async (c) => c.json(await readNetWorth(c.env.DB, c.req.valid('query').range ?? DEFAULT_NET_WORTH_RANGE, new Date())))
  // Spending by Category for a named period or two dates, Transfers left out. No page calls it (see above).
  .get('/spending', validate('query', spendingQuery), async (c) => c.json(await readSpendingByCategory(c.env.DB, rangeOf(c.req.valid('query'), new Date()))))
