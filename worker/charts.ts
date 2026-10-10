import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { rangeOf, spendingQuery } from './chart-spending'
import { DEFAULT_NET_WORTH_RANGE, netWorthQuery, readNetWorth } from './net-worth'
import { readSpendingByCategory } from './spending-by-category'
import { validate } from './validate'

// The numbers behind the charts (the Dashboard and the Charts page). Read-only, so every Member can use them; the guard in app.ts already
// refuses a change from anyone but the Admin. Net worth is balance history added up (net-worth.ts) and spending is spending.ts's (spending-by-category.ts).
export const charts = new Hono<AppEnv>()
  // The tracked Accounts' balances added up at the end of each month, for the range asked for (the last 24 months when none is).
  .get('/net-worth', validate('query', netWorthQuery), async (c) => c.json(await readNetWorth(c.env.DB, c.req.valid('query').range ?? DEFAULT_NET_WORTH_RANGE, new Date())))
  // Spending by Category for a named period or two dates, Transfers left out.
  .get('/spending', validate('query', spendingQuery), async (c) => c.json(await readSpendingByCategory(c.env.DB, rangeOf(c.req.valid('query'), new Date()))))
