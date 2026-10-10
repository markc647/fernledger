import * as z from 'zod/mini'
import { UNCOUNTED_SQL } from './balance-check'
import type { BalanceStatus } from './balance-rules'
import { ANCHOR, HISTORY_CTES } from './balances'
import { isQueryDate } from './dates'

// The data of the balances-over-time Report (GET /api/reports/balances), one Account at a time. Its numbers are balance history
// (worker/balances.ts), not a second calculation: the query below is the history's own CTEs with a few rows picked out of them,
// the last balance of each month. A month with no Transactions has no row in the history, so it carries the balance before it;
// the Report writes one row for each month, each dated its last day (or the last day of the dates, or the last day held).
//
// Cost (ADR 0004): the history is one pass over the Account's Transactions however narrow the dates (a balance is the bank's
// balance less every Transaction after it, so no date can be skipped), and the Report returns about a row a month rather than
// the history's row a day. Tests pin the rows read against the history's own (worker/report-balances.test.ts).

const digits = z.string().check(z.regex(/^[1-9]\d{0,8}$/))

/** The query string of the Report, validated before anything runs. A refusal names the field. */
export const balancesReportQuery = z
  .object({
    accountId: digits,
    from: z.string().check(z.refine(isQueryDate)),
    to: z.string().check(z.refine(isQueryDate)),
  })
  .check(z.refine((q) => q.from <= q.to, { path: ['to'] }))

export type BalancesReportRequest = { accountId: number; from: string; to: string }

/**
 * Four kinds of row from the Account's history, each an aggregate over it (?1 = the Account, ?2 and ?3 = the dates, both included).
 * SQLite takes the bare columns of a MIN or MAX from the row that has the minimum or maximum, so each row carries that date's balance:
 * - `first`: the first date the history has, with the balance before that date (its balance less the day's own `net`: the opening
 *   balance the bank's balance implies);
 * - `last`: the last date it has, and the balance then;
 * - `before`: the last date before ?2 and its balance, which is the balance when ?2 begins (no row if ?2 is on or before `first`);
 * - `month`: for each month, the last date from ?2 to ?3 and its balance.
 * `usable` leaves out the history of an Account with no bank balance to work from, whose balances are null, so it gives no rows.
 * An aggregate reads the history once and sorts nothing (ORDER BY ... LIMIT 1 sorted it each time).
 */
export const REPORT_HISTORY = `
  WITH ${HISTORY_CTES},
  usable AS (SELECT date, net, balanceCents FROM history WHERE balanceCents IS NOT NULL)
  SELECT 'first' AS kind, MIN(date) AS date, balanceCents - net AS balanceCents FROM usable HAVING COUNT(*) > 0
  UNION ALL SELECT 'last', MAX(date), balanceCents FROM usable HAVING COUNT(*) > 0
  UNION ALL SELECT 'before', MAX(date), balanceCents FROM usable WHERE date < ?2 HAVING COUNT(*) > 0
  UNION ALL SELECT 'month', MAX(date), balanceCents FROM usable WHERE date >= ?2 AND date <= ?3 GROUP BY substr(date, 1, 7)`

const ACCOUNT_EXISTS = 'SELECT id FROM accounts WHERE id = ?'
const LATEST_STATUS = 'SELECT status FROM balance_checks WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1'

// The balances the bank gave on the dates a row can have: a month's last day, the last of the dates asked for (?3), and the date of
// the balance the history is worked out from (the newest the Transactions reach), which is where the history ends.
const BANK_BALANCES = `
  SELECT as_of_date AS date, bank_cents AS bankCents FROM balance_checks
  WHERE account_id = ?1 AND status NOT IN (${UNCOUNTED_SQL}) AND as_of_date >= ?2 AND as_of_date <= ?3
    AND (as_of_date = ?3
      OR as_of_date = date(as_of_date, 'start of month', '+1 month', '-1 day')
      OR as_of_date = (SELECT MAX(as_of_date) FROM balance_checks WHERE account_id = ?1 AND status NOT IN (${UNCOUNTED_SQL})))
  ORDER BY as_of_date`

// A check covers the Transactions after the earlier balance it was compared with (`checked_against`, ADR 0011) up to its own date,
// so it is in the dates when it ends on or after the first and begins before the last.
const OVERLAPPING = 'account_id = ?1 AND as_of_date >= ?2 AND checked_against < ?3'
const CHECKED = `SELECT COUNT(*) AS checked FROM balance_checks WHERE ${OVERLAPPING} AND status IN ('matched', 'differs')`
const DIFFERENCES = `
  SELECT as_of_date AS asOfDate, checked_against AS since, difference_cents AS differenceCents
  FROM balance_checks WHERE ${OVERLAPPING} AND status = 'differs' ORDER BY as_of_date`

export type HistoryRow = { kind: 'first' | 'last' | 'before' | 'month'; date: string; balanceCents: number }
export type BankBalance = { date: string; bankCents: number }
export type Anchor = { asOfDate: string; balanceCents: number }
/** A Balance Check that found the bank and the Transactions disagreeing: the bank's balance less the calculated one, since the date of the balance it was compared with. */
export type BalanceDifference = { asOfDate: string; since: string; differenceCents: number }

/** One line of the Report: the balance at the end of `date`, what it changed by since the line before, and the bank's own figure for that day if it gave one. */
export type BalanceLine = { date: string; balanceCents: number; changeCents: number; bankCents: number | null }

export type BalancesReport = {
  accountId: number
  from: string
  to: string
  /** The bank balance every figure is worked out from (the newest the Transactions reach); null while there is none to work from. */
  anchor: Anchor | null
  /** The status of the Account's newest bank balance, counted or not, to say why there is no anchor. */
  latestStatus: BalanceStatus | null
  /** The first and last dates balances can be worked out for; null when there is no anchor. Nothing is claimed outside them. */
  held: { from: string; to: string } | null
  /** The balance when the dates begin, or null when none of them is held. `beforeFirst`: it is the balance before the first Transaction held, because the dates begin on or before it. */
  opening: { balanceCents: number; beforeFirst: boolean } | null
  /** A line for each month the dates and the dates held share, oldest first. */
  rows: BalanceLine[]
  /** The balance on the last date of the dates held, which is `to` unless the Transactions held end sooner. */
  closing: { date: string; balanceCents: number } | null
  /** How many Balance Checks (bank balance against Transactions) cover some of the dates, and which of them found a difference. */
  checked: number
  differences: BalanceDifference[]
}

/** The month after `month` (`2026-12` is followed by `2027-01`). */
const nextMonth = (month: string) => {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
}
/** The last day of `month` (`2026-02` gives `2026-02-28`). */
const lastDay = (month: string) => {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`
}

/**
 * The Report from what the history query and the checks gave, with no database. Dates are `YYYY-MM-DD`, which compare correctly
 * as text. The balances are the history's, picked, never recalculated:
 * - the dates shared with the dates held are `start` to `end`, and each month in them is a line;
 * - a line is dated the month's last day, or `end` for the last one, and its balance is the history's last balance in that month,
 *   or the balance before it when the month has no Transactions;
 * - the opening balance is the history's balance at the end of the day before `from`, or the balance before the first Transaction
 *   held when `from` is on or before it.
 */
export function balancesReport(
  request: BalancesReportRequest,
  data: { anchor: Anchor | null; latestStatus: BalanceStatus | null; history: HistoryRow[]; bank: BankBalance[]; checked: number; differences: BalanceDifference[] },
): BalancesReport {
  const { accountId, from, to } = request
  const common = { accountId, from, to, anchor: data.anchor, latestStatus: data.latestStatus, checked: data.checked, differences: data.differences }
  const nothing = { opening: null, rows: [], closing: null }
  const first = data.history.find((row) => row.kind === 'first')
  const last = data.history.find((row) => row.kind === 'last')
  if (!first || !last) return { ...common, held: null, ...nothing }

  const held = { from: first.date, to: last.date }
  const start = from > held.from ? from : held.from
  const end = to < held.to ? to : held.to
  if (start > end) return { ...common, held, ...nothing }

  // `first.balanceCents` is the balance before the first date held. Past it, `from` has a date before it in the history.
  const before = data.history.find((row) => row.kind === 'before')
  if (from > held.from && !before) throw new Error('The history has no balance before the dates')
  const opening = from > held.from ? { balanceCents: before!.balanceCents, beforeFirst: false } : { balanceCents: first.balanceCents, beforeFirst: true }

  const lastOfMonth = new Map(data.history.filter((row) => row.kind === 'month').map((row) => [row.date.slice(0, 7), row.balanceCents]))
  const bank = new Map(data.bank.map((b) => [b.date, b.bankCents]))
  const rows: BalanceLine[] = []
  let previous = opening.balanceCents
  for (let month = start.slice(0, 7); month <= end.slice(0, 7); month = nextMonth(month)) {
    const monthEnd = lastDay(month)
    const date = monthEnd < end ? monthEnd : end
    const balanceCents = lastOfMonth.get(month) ?? previous
    rows.push({ date, balanceCents, changeCents: balanceCents - previous, bankCents: bank.get(date) ?? null })
    previous = balanceCents
  }
  return { ...common, held, opening, rows, closing: { date: end, balanceCents: previous } }
}

/** Reads the Report for one Account in one D1 batch (seven statements; ADR 0004 allows 50). Null when there is no such Account. */
export async function readBalancesReport(db: D1Database, request: BalancesReportRequest): Promise<BalancesReport | null> {
  const { accountId, from, to } = request
  const [account, anchor, latest, history, bank, checked, differences] = await db.batch([
    db.prepare(ACCOUNT_EXISTS).bind(accountId),
    db.prepare(ANCHOR).bind(accountId),
    db.prepare(LATEST_STATUS).bind(accountId),
    db.prepare(REPORT_HISTORY).bind(accountId, from, to),
    db.prepare(BANK_BALANCES).bind(accountId, from, to),
    db.prepare(CHECKED).bind(accountId, from, to),
    db.prepare(DIFFERENCES).bind(accountId, from, to),
  ])
  if (account!.results.length === 0) return null
  return balancesReport(request, {
    anchor: (anchor!.results[0] as Anchor | undefined) ?? null,
    latestStatus: (latest!.results[0] as { status: BalanceStatus } | undefined)?.status ?? null,
    history: history!.results as HistoryRow[],
    bank: bank!.results as BankBalance[],
    checked: (checked!.results[0] as { checked: number }).checked,
    differences: differences!.results as BalanceDifference[],
  })
}
