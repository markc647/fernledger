import { monthEnd, nextMonth } from './months'
import { REPORT_HISTORY, type HistoryRow } from './report-balances'

// Net worth over time (GET /api/charts/net-worth): the Accounts' balances added up at the end of each month. Every balance is balance history
// (worker/balances.ts), picked out at month-ends in SQL by the balances Report's own query (REPORT_HISTORY), never calculated a second time;
// this file only adds the Accounts together. Net worth here is the balance of the tracked Accounts and nothing else (README: What it doesn't do).
//
// Cost (ADR 0004): one statement for the list of Accounts and one for each Account's history, so a request reads every Account's
// Transactions about six times (the Report's own figure) and uses 1 + N of the 50 D1 queries. More than MAX_NET_WORTH_ACCOUNTS Accounts
// are refused, with a flag the page words, rather than a total of only some of them. The Worker adds up one number per Account per month.

/** Accounts a request reads: 1 statement for the list and 1 for each Account's history must stay within the 50 D1 queries of one invocation (ADR 0004). */
export const MAX_NET_WORTH_ACCOUNTS = 49

/** REPORT_HISTORY takes the dates it picks months from; these are every date, so no month is left out and no Transaction counts as "before". */
export const EVERY_DATE = { from: '0000-01-01', to: '9999-12-31' }

export type NetWorthAccount = { accountId: number; accountName: string }

/** The total of the counted Accounts at the end of `date`: a month's last day, or for the last month the last date any of them holds. */
export type NetWorthPoint = { date: string; cents: number }

export type NetWorth = {
  /** The Accounts in the total: those with a bank balance to work from. */
  counted: NetWorthAccount[]
  /** The Accounts left out because they have no such balance yet. */
  notCounted: NetWorthAccount[]
  /** The total at the end of each month from the first date any counted Account holds to the last, oldest first. */
  points: NetWorthPoint[]
  /** Set, with no points, when there are more Accounts than one request can read. */
  tooManyAccounts: { count: number; limit: number } | null
}

/**
 * The total at the end of each month, from each Account's picked rows (`REPORT_HISTORY`), with no database:
 * - an Account counts from its own history: its balance at the end of a month is the last balance the history has in that month, or the
 *   one before it when the month has no Transactions (so the months after its last date repeat its last balance);
 * - in the months before its first date held it counts at the balance it opened with (the balance the bank's balance implies before its
 *   first Transaction), so an Account that begins later does not make the total jump;
 * - the months run from the earliest first date held to the latest last date; the last point is dated that last date, not the month's end,
 *   so the line ends on the last day Fernledger holds a balance for.
 */
export function netWorthPoints(histories: HistoryRow[][]): NetWorthPoint[] {
  const series = histories.flatMap((rows) => {
    const first = rows.find((row) => row.kind === 'first')
    const last = rows.find((row) => row.kind === 'last')
    if (!first || !last) return []
    return [{ first, last, atMonthEnd: new Map(rows.filter((row) => row.kind === 'month').map((row) => [row.date.slice(0, 7), row.balanceCents])) }]
  })
  if (series.length === 0) return []

  const startMonth = series.map((s) => s.first.date.slice(0, 7)).reduce((a, b) => (a < b ? a : b))
  const endDate = series.map((s) => s.last.date).reduce((a, b) => (a > b ? a : b))
  const balances = series.map((s) => s.first.balanceCents)
  const points: NetWorthPoint[] = []
  for (let month = startMonth; month <= endDate.slice(0, 7); month = nextMonth(month)) {
    let cents = 0
    series.forEach((s, i) => {
      balances[i] = s.atMonthEnd.get(month) ?? balances[i]!
      cents += balances[i]!
    })
    points.push({ date: month === endDate.slice(0, 7) ? endDate : monthEnd(month), cents })
  }
  return points
}

/** The Accounts, by name as everywhere else. */
export const ACCOUNTS = 'SELECT id, name FROM accounts ORDER BY name COLLATE NOCASE, id'

/** One statement for each Account: its history picked at month-ends (?1 = the Account). The same statements the Report runs. */
export const historyStatements = (db: D1Database, accounts: { id: number }[]) => accounts.map((account) => db.prepare(REPORT_HISTORY).bind(account.id, EVERY_DATE.from, EVERY_DATE.to))

/** Reads net worth in two round trips: the Accounts, then one batch of their histories. */
export async function readNetWorth(db: D1Database): Promise<NetWorth> {
  const { results: accounts } = await db.prepare(ACCOUNTS).all<{ id: number; name: string }>()
  if (accounts.length > MAX_NET_WORTH_ACCOUNTS) return { counted: [], notCounted: [], points: [], tooManyAccounts: { count: accounts.length, limit: MAX_NET_WORTH_ACCOUNTS } }
  if (accounts.length === 0) return { counted: [], notCounted: [], points: [], tooManyAccounts: null }

  const histories = (await db.batch<HistoryRow>(historyStatements(db, accounts))).map((result) => result.results)
  const counted: NetWorthAccount[] = []
  const notCounted: NetWorthAccount[] = []
  for (const [i, account] of accounts.entries()) {
    const entry = { accountId: account.id, accountName: account.name }
    // An Account with no bank balance to work from has no rows at all in its history (REPORT_HISTORY leaves out null balances).
    if (histories[i]!.length > 0) counted.push(entry)
    else notCounted.push(entry)
  }
  return { counted, notCounted, points: netWorthPoints(histories), tooManyAccounts: null }
}
