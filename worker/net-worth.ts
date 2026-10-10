import * as z from 'zod/mini'
import type { BalanceStatus } from './balance-rules'
import { carryForward } from './month-balances'
import { monthEnd, monthsBefore, monthStart, nzMonth } from './months'
import { REPORT_HISTORY, type HistoryRow } from './report-balances'

// Net worth over time (GET /api/charts/net-worth): the Accounts' balances added up at the end of each month. Every balance is balance history
// (worker/balances.ts), picked out at month-ends in SQL by the balances Report's own query (REPORT_HISTORY), never calculated a second time, and carried
// across quiet months by the Report's own rule (month-balances.ts); this file only adds the Accounts together. Net worth here is the money in the tracked
// Accounts and nothing else (README: What it doesn't do).
//
// A range narrows what is returned, not what is read: balance history is worked out from every Transaction of an Account whatever dates are asked for, so
// the request reads each Transaction about six times for any range (ADR 0004; charts.test.ts pins it). It takes one statement for the list of Accounts and one
// for each Account's history, so 1 + N of the 50 D1 queries; more than MAX_NET_WORTH_ACCOUNTS Accounts are refused, with a flag the page words, rather
// than a total of only some of them.

/** The ranges a request can ask for, each ending with this month: the last 24 months, the last 5 years, or every month there is. */
export const NET_WORTH_RANGES = ['24-months', '5-years', 'all'] as const
export type NetWorthRange = (typeof NET_WORTH_RANGES)[number]

/** The range a request that names none gets, and the one the Dashboard asks for. */
export const DEFAULT_NET_WORTH_RANGE: NetWorthRange = '24-months'

/** The query string: the range, which a refusal names. */
export const netWorthQuery = z.object({ range: z.optional(z.enum(NET_WORTH_RANGES)) })

/** Accounts a request reads: 1 statement for the list and 1 for each Account's history must stay within the 50 D1 queries of one invocation (ADR 0004). */
export const MAX_NET_WORTH_ACCOUNTS = 49

/** REPORT_HISTORY takes the dates it picks months from; these are every date, so a range that is all begins before any Transaction and ends after every one. */
export const EVERY_DATE = { from: '0000-01-01', to: '9999-12-31' }

/** The first date a range shows: the first day of a whole NZ month, so a range is made of the months its points are. */
export function rangeStart(range: NetWorthRange, now: Date): string {
  const month = nzMonth(now)
  switch (range) {
    case '24-months':
      return monthStart(monthsBefore(month, 23))
    case '5-years':
      return monthStart(monthsBefore(month, 59))
    case 'all':
      return EVERY_DATE.from
  }
}

export type NetWorthAccount = { accountId: number; accountName: string }

/** An Account in the total, and the last date it holds: after that its balance is carried forward, so a date well before the others' means its Transactions stop early. */
export type CountedAccount = NetWorthAccount & { lastDate: string }

/** An Account left out, and the status of its newest bank balance, counted or not: the Summary's own reason for why it has no balance. */
export type UncountedAccount = NetWorthAccount & { latestStatus: BalanceStatus | null }

/** The total of the counted Accounts at the end of `date`: a month's last day, or for the last month the last date any of them holds. */
export type NetWorthPoint = { date: string; cents: number }

export type NetWorth = {
  range: NetWorthRange
  /** The Accounts in the total: those with a bank balance to work from. */
  counted: CountedAccount[]
  /** The Accounts left out because they have no such balance yet. */
  notCounted: UncountedAccount[]
  /** The total at the end of each month in the range, oldest first, from the first month the range and the history share to the last date any Account holds. */
  points: NetWorthPoint[]
  /** Set, with no points, when there are more Accounts than one request can read. */
  tooManyAccounts: { count: number; limit: number } | null
}

/**
 * The total at the end of each month, from each Account's picked rows (`REPORT_HISTORY`, asked from `from`), with no database:
 * - an Account's balance at the end of a month is the last balance the history has in that month, or the balance before it when the month has no
 *   Transactions (`carryForward`), so the months after its last date repeat its last balance;
 * - the first month of a range starts from the balance the history had at the end of the last date before it (its `before` row), and where the Account has
 *   no Transaction before the range from the balance it opened with: the balance the bank's balance implies before its first Transaction. So in the months before
 *   an Account's first date held it counts at that balance, which is an estimate (money moved into it from another Account before its history begins is
 *   counted in both), and an Account that begins later does not make the total jump;
 * - the months run from the first month of the range (or the earliest first date held, if later) to the latest last date any Account holds, and the last point is
 *   dated that last date, not the month's end, so the line ends on the last day Fernledger holds a balance for. A range that begins after that date shows the
 *   last month alone.
 */
export function netWorthPoints(histories: HistoryRow[][], from: string): NetWorthPoint[] {
  const series = histories.flatMap((rows) => {
    const first = rows.find((row) => row.kind === 'first')
    const last = rows.find((row) => row.kind === 'last')
    if (!first || !last) return []
    const before = rows.find((row) => row.kind === 'before')
    return [{ first, last, opening: (before ?? first).balanceCents, atMonthEnd: new Map(rows.filter((row) => row.kind === 'month').map((row) => [row.date.slice(0, 7), row.balanceCents])) }]
  })
  if (series.length === 0) return []

  const endDate = series.map((s) => s.last.date).reduce((a, b) => (a > b ? a : b))
  const endMonth = endDate.slice(0, 7)
  const earliest = series.map((s) => s.first.date.slice(0, 7)).reduce((a, b) => (a < b ? a : b))
  const wanted = from.slice(0, 7)
  const startMonth = [wanted > earliest ? wanted : earliest, endMonth].reduce((a, b) => (a < b ? a : b))

  const balances = series.map((s) => carryForward(s.atMonthEnd, startMonth, endMonth, s.opening))
  const count = balances[0]!.length // the same for every Account: one for each month from the first to the last
  return Array.from({ length: count }, (_, i) => ({
    date: i === count - 1 ? endDate : monthEnd(monthsBefore(startMonth, -i)), // `monthsBefore` by a negative number is the month after
    cents: balances.reduce((sum, account) => sum + account[i]!, 0),
  }))
}

/** The Accounts with the status of each one's newest bank balance (as the Summary has it), by name as everywhere else. */
export const ACCOUNTS = `
  SELECT a.id, a.name, (SELECT status FROM balance_checks WHERE account_id = a.id ORDER BY as_of_date DESC LIMIT 1) AS latestStatus
  FROM accounts a ORDER BY a.name COLLATE NOCASE, a.id`

/** One statement for each Account: its history picked at month-ends from `from` (?1 = the Account). The same statements the Report runs. */
export const historyStatements = (db: D1Database, accounts: { id: number }[], from: string) => accounts.map((account) => db.prepare(REPORT_HISTORY).bind(account.id, from, EVERY_DATE.to))

/** Reads net worth in two round trips: the Accounts, then one batch of their histories. */
export async function readNetWorth(db: D1Database, range: NetWorthRange, now: Date): Promise<NetWorth> {
  const { results: accounts } = await db.prepare(ACCOUNTS).all<{ id: number; name: string; latestStatus: BalanceStatus | null }>()
  const nothing = { range, counted: [], notCounted: [], points: [] }
  if (accounts.length > MAX_NET_WORTH_ACCOUNTS) return { ...nothing, tooManyAccounts: { count: accounts.length, limit: MAX_NET_WORTH_ACCOUNTS } }
  if (accounts.length === 0) return { ...nothing, tooManyAccounts: null }

  const from = rangeStart(range, now)
  const histories = (await db.batch<HistoryRow>(historyStatements(db, accounts, from))).map((result) => result.results)
  const counted: CountedAccount[] = []
  const notCounted: UncountedAccount[] = []
  for (const [i, account] of accounts.entries()) {
    const last = histories[i]!.find((row) => row.kind === 'last')
    // An Account with no bank balance to work from has no rows at all in its history (REPORT_HISTORY leaves out null balances).
    if (last) counted.push({ accountId: account.id, accountName: account.name, lastDate: last.date })
    else notCounted.push({ accountId: account.id, accountName: account.name, latestStatus: account.latestStatus })
  }
  return { range, counted, notCounted, points: netWorthPoints(histories, from), tooManyAccounts: null }
}
