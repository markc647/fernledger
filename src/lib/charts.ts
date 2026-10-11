import type { SpendingPeriod } from '@/generated/api/chart-spending'
import type { CountedAccount, NetWorthRange, UncountedAccount } from '@/generated/api/net-worth'
import type { SpendingCategory } from '@/generated/api/spending-by-category'
import { noBalanceHint, noBalanceReason } from './balance-check'
import { isSearchDate } from './date-range'
import { formatBalance, formatDate, formatMonth } from './format'

// The words and choices of the charts (the Dashboard and the Charts page). The numbers come from the Worker (worker/net-worth.ts,
// worker/spending-by-category.ts) and are shown as they arrive: this file chooses which to draw and how to say what they are. It adds up no money.

export type { NetWorthRange, SpendingCategory, SpendingPeriod }

/** The periods the Worker names (a NZ month is whatever the Worker's clock says, not the device's), in the order they are offered. A new one the Worker adds fails to compile until it has words here. */
export const PERIOD_LABELS: Record<SpendingPeriod, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'past-3-months': 'Past 3 months',
  'past-12-months': 'Past 12 months',
}
export const PERIODS = Object.keys(PERIOD_LABELS) as SpendingPeriod[]

/** The ranges of months net worth can be drawn for, in the order they are offered. The Dashboard draws the first. */
export const NET_WORTH_RANGE_LABELS: Record<NetWorthRange, string> = {
  '24-months': 'Last 24 months',
  '5-years': 'Last 5 years',
  all: 'All history',
}
export const NET_WORTH_RANGES = Object.keys(NET_WORTH_RANGE_LABELS) as NetWorthRange[]
export const DASHBOARD_NET_WORTH_RANGE: NetWorthRange = '24-months'

/** The most Categories drawn as bars. More would not fit a phone's screen, and the table lists them all. */
export const CHART_BARS = 12

/**
 * What to draw and what to say about the Spending Categories the Worker gave (it has put the biggest first): the table lists every one, a fully refunded Category as $0.00,
 * so money that went out and came back is still in view; the bars are the ones that spent something, at most `CHART_BARS`; and `leftOut` is how many of those the chart
 * left out. The Worker gives a Category only when it has Transactions in the dates, so none is listed that has nothing in it.
 */
export function barsOf(categories: SpendingCategory[]) {
  const spent = categories.filter((category) => category.cents > 0)
  return { rows: categories, bars: spent.slice(0, CHART_BARS), leftOut: Math.max(0, spent.length - CHART_BARS) }
}

/** `name` cut to `maxChars` characters with an ellipsis, for an axis with room for only so many. The whole name is in the tooltip and the table. */
export function shorten(name: string, maxChars: number) {
  const chars = Array.from(name)
  if (chars.length <= maxChars) return name
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`
}

const lastDay = (month: string) => String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')

/** The dates a figure is for, in words: a whole month by its name ("October 2026"), one day by its date, else both dates. */
export function describeDates(from: string, to: string) {
  const month = from.slice(0, 7)
  if (from === `${month}-01` && to === `${month}-${lastDay(month)}`) return formatMonth(month)
  if (from === to) return formatDate(from)
  return `${formatDate(from)} to ${formatDate(to)}`
}

/** What is wrong with the dates chosen, if anything, and the field to mark. Both must be real dates in the years the Worker takes, in order. */
export function datesProblem(from: string, to: string): { field: 'from' | 'to'; message: string } | null {
  if (from === '') return { field: 'from', message: 'Choose a From date.' }
  if (to === '') return { field: 'to', message: 'Choose a To date.' }
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (!isSearchDate(value)) return { field, message: `The “${field === 'from' ? 'From' : 'To'}” date must be a real date from the year 2000 to 2100.` }
  }
  if (from > to) return { field: 'to', message: 'The “To” date is before the “From” date. Change one of them to see the chart.' }
  return null
}

/** What a screen reader says for the net worth chart, which it takes as one image: where the line starts and ends, and where the figures are. */
export function netWorthSummary(points: { date: string; cents: number }[]) {
  const last = points.at(-1)
  if (!last) return ''
  if (points.length === 1) return `Net worth was ${formatBalance(last.cents)} on ${formatDate(last.date)}.`
  const first = points[0]!
  return `Line chart of net worth by month. It was ${formatBalance(first.cents)} at the end of ${formatMonth(first.date.slice(0, 7))} and ${formatBalance(last.cents)} on ${formatDate(last.date)}. The figures for every month are under “Show the figures”.`
}

/** What a screen reader says for the spending chart, which it takes as one image. */
export function spendingSummary(dates: string, drawn: number) {
  return `Bar chart of the ${drawn === 1 ? 'one Category' : `${drawn} Categories`} that spent the most in ${dates}. The figures for every Category are in the table below.`
}

/** What the chart is of, in a line under it: the money in the Accounts and nothing else, and how the months before an Account's history are drawn. */
export const NET_WORTH_ABOUT = [
  "Only the money in these Accounts, added up at the end of each month from the bank balances Fernledger holds. A loan to or from someone whose account isn't tracked shows as a fall or a rise.",
  "Months before an Account's first Transaction use the balance it had when its Transactions begin, so they are an estimate: money that moved into it by then may be counted twice. After its last Transaction an Account keeps its last balance. The last point is the latest date Fernledger holds, not the end of the month.",
] as const

/** What the page says when there are more Accounts than one request can add up. */
export const tooManyAccountsMessage = (count: number, limit: number) =>
  `Net worth can't be drawn for this many Accounts. It works for up to ${limit}, and this Fernledger has ${count}, so it shows nothing rather than a total that leaves some out.`

/** One Account left out of the total: why, in the Summary's own words, and what the Admin can do about it. */
export const notCountedLine = (account: UncountedAccount) => `${account.accountName}: ${noBalanceReason(account.latestStatus)}. ${noBalanceHint(account.latestStatus)}`

/** The Accounts whose last Transaction is in an earlier month than the line's last point: their balance is carried forward from there, so the line is flatter than the money was. */
export function stoppedEarly(counted: CountedAccount[], points: { date: string }[]) {
  const latest = points.at(-1)
  return latest ? counted.filter((account) => account.lastDate.slice(0, 7) < latest.date.slice(0, 7)) : []
}

/** One Account whose Transactions stop early, in words, and what the Admin can do about it. */
export const stoppedEarlyLine = (account: CountedAccount) =>
  `${account.accountName}: its last Transaction is ${formatDate(account.lastDate)}, and its balance stays the same after that. The Admin can import a newer bank file to bring it up to date.`
