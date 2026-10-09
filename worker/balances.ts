import { Hono } from 'hono'
import * as z from 'zod/mini'
import { isoDate } from './account-fields'
import type { AppEnv } from './app-env'
import { UNCOUNTED_SQL } from './balance-check'
import type { BalanceStatus } from './balance-rules'
import { validate } from './validate'

// Read-only, so every Member can use these; the guard in app.ts already refuses a change from anyone but the Admin.
// A balance is the latest bank balance whose date the saved Transactions reach (balance-rules.ts), plus the
// Transactions after it. Each query reads the Account's Transactions from that balance's date on (the date index), or
// once through for history, which is one window-function pass rather than a loop in the Worker (ADR 0004).

// The newest balance of the Account (the outer query's `a`) that can anchor history.
const ANCHOR_ID = `SELECT id FROM balance_checks WHERE account_id = a.id AND status NOT IN (${UNCOUNTED_SQL}) ORDER BY as_of_date DESC LIMIT 1`

export const CURRENT = `
  SELECT a.id AS accountId, a.name AS accountName,
         b.bank_cents + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                                  WHERE t.account_id = a.id AND t.date >= b.as_of_date AND (t.date > b.as_of_date OR t.id > b.through_transaction_id)), 0) AS balanceCents,
         MAX(b.as_of_date, COALESCE((SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id AND t.date >= b.as_of_date), b.as_of_date)) AS asOfDate,
         a.cutover_date AS cutoverDate,
         (SELECT status FROM balance_checks WHERE account_id = a.id ORDER BY as_of_date DESC LIMIT 1) AS latestStatus
  FROM accounts a LEFT JOIN balance_checks b ON b.id = (${ANCHOR_ID})
  ORDER BY a.name COLLATE NOCASE, a.id`

// Balance at the end of each day with Transactions (and the anchor's day): the opening balance the anchor implies,
// plus the running total of the days. Working backwards from the bank's balance is the same sum.
export const HISTORY = `
  WITH anchor AS (
    SELECT as_of_date, bank_cents, through_transaction_id FROM balance_checks
    WHERE account_id = ?1 AND status NOT IN (${UNCOUNTED_SQL}) ORDER BY as_of_date DESC LIMIT 1),
  days AS (
    SELECT date, SUM(net) AS net FROM (
      SELECT date, amount_cents AS net FROM transactions WHERE account_id = ?1
      UNION ALL SELECT as_of_date, 0 FROM anchor)
    GROUP BY date),
  counted AS (
    SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM transactions t, anchor
    WHERE t.account_id = ?1 AND (t.date < anchor.as_of_date OR (t.date = anchor.as_of_date AND t.id <= anchor.through_transaction_id))),
  history AS (
    SELECT date, (SELECT bank_cents FROM anchor) - (SELECT total FROM counted) + SUM(net) OVER (ORDER BY date) AS balanceCents FROM days)
  SELECT date, balanceCents FROM history
  WHERE balanceCents IS NOT NULL AND (?2 IS NULL OR date >= ?2) AND (?3 IS NULL OR date <= ?3)
  ORDER BY date`

const ANCHOR = `SELECT as_of_date AS asOfDate, bank_cents AS balanceCents FROM balance_checks WHERE account_id = ? AND status NOT IN (${UNCOUNTED_SQL}) ORDER BY as_of_date DESC LIMIT 1`

const rangeQuery = z.object({ from: z.optional(isoDate), to: z.optional(isoDate) })

// `latestStatus` is the status of the Account's newest bank balance, counted or not, so the Summary can say why there is
// no balance (the newest is after the Cutover Date, or the file ended before it) rather than that there is none.
type CurrentBalance = {
  accountId: number
  accountName: string
  balanceCents: number | null
  asOfDate: string | null
  cutoverDate: string | null
  latestStatus: BalanceStatus | null
}
type HistoryPoint = { date: string; balanceCents: number }

export const balances = new Hono<AppEnv>()
  // Every Account's balance now. Null for an Account with no bank balance yet to start from (`latestStatus` says why).
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(CURRENT).all<CurrentBalance>()
    return c.json({ accounts: results })
  })
  // One Account's balance at the end of each day it had Transactions, oldest first, worked backwards from its latest
  // bank balance. `from` and `to` (inclusive) limit the points returned, not the sum.
  .get('/:accountId/history', validate('query', rangeQuery), async (c) => {
    const accountId = Number(c.req.param('accountId'))
    const { from, to } = c.req.valid('query')
    const db = c.env.DB
    const account = Number.isSafeInteger(accountId) ? await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(accountId).first() : null
    if (!account) return c.json({ error: 'Not found' }, 404)

    const [anchor, points] = await db.batch([db.prepare(ANCHOR).bind(accountId), db.prepare(HISTORY).bind(accountId, from ?? null, to ?? null)])
    return c.json({ accountId, anchor: (anchor!.results[0] as { asOfDate: string; balanceCents: number } | undefined) ?? null, points: points!.results as HistoryPoint[] })
  })

type Difference = { accountId: number; accountName: string; asOfDate: string; since: string; differenceCents: number }
type LatestCheck = { accountId: number; accountName: string; asOfDate: string | null; status: BalanceStatus | null }

const DIFFERENCES = `
  SELECT c.account_id AS accountId, a.name AS accountName, c.as_of_date AS asOfDate, c.checked_against AS since, c.difference_cents AS differenceCents
  FROM balance_checks c JOIN accounts a ON a.id = c.account_id
  WHERE c.status = 'differs'
  ORDER BY a.name COLLATE NOCASE, a.id, c.as_of_date DESC`

const LATEST_CHECKS = `
  SELECT a.id AS accountId, a.name AS accountName, c.as_of_date AS asOfDate, c.status AS status
  FROM accounts a LEFT JOIN balance_checks c ON c.id = (SELECT id FROM balance_checks WHERE account_id = a.id ORDER BY as_of_date DESC LIMIT 1)
  ORDER BY a.name COLLATE NOCASE, a.id`

export const balanceChecks = new Hono<AppEnv>()
  // The warnings: every span where the bank and the Transactions disagree, newest first within each Account. `since` is
  // the date they last agreed. `accounts` gives each Account's latest check, so the page can say when all is well.
  .get('/', async (c) => {
    const db = c.env.DB
    const [differences, accounts] = await db.batch([db.prepare(DIFFERENCES), db.prepare(LATEST_CHECKS)])
    return c.json({ differences: differences!.results as Difference[], accounts: accounts!.results as LatestCheck[] })
  })
