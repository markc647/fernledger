import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { rangeOf, readSpending, spendingQuery } from './chart-spending'
import { readNetWorth } from './net-worth'
import { validate } from './validate'

// The numbers behind the charts (the Dashboard and the Charts page). Read-only, so every Member can use them; the guard in app.ts already
// refuses a change from anyone but the Admin. Net worth is balance history added up (net-worth.ts) and spending is spending.ts's (chart-spending.ts).
export const charts = new Hono<AppEnv>()
  // The tracked Accounts' balances added up at the end of each month.
  .get('/net-worth', async (c) => c.json(await readNetWorth(c.env.DB)))
  // Spending by Category for a named period or two dates, Transfers left out.
  .get('/spending', validate('query', spendingQuery), async (c) => c.json(await readSpending(c.env.DB, rangeOf(c.req.valid('query'), new Date()))))
