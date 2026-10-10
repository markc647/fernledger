import type { SpendingCategory, SpendingPeriod } from '@/generated/api/chart-spending'
import { isSearchDate } from './date-range'
import { formatBalance, formatDate, formatMonth } from './format'

// The words and choices of the charts (the Dashboard and the Charts page). The numbers come from the Worker (worker/net-worth.ts,
// worker/chart-spending.ts) and are shown as they arrive: this file chooses which to draw and how to say what they are. It adds up no money.

export type { SpendingCategory, SpendingPeriod }

/** The periods the Worker names (a NZ month is whatever the Worker's clock says, not the device's), in the order they are offered. A new one the Worker adds fails to compile until it has words here. */
export const PERIOD_LABELS: Record<SpendingPeriod, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'past-3-months': 'Past 3 months',
  'past-12-months': 'Past 12 months',
}
export const PERIODS = Object.keys(PERIOD_LABELS) as SpendingPeriod[]

/** The most Categories drawn as bars. More would not fit a phone's screen, and the table lists them all. */
export const CHART_BARS = 12

/** The Categories to draw: those that spent something (the Worker has put the biggest first), at most `CHART_BARS`, and how many were left out. */
export function barsOf(categories: SpendingCategory[]) {
  const spent = categories.filter((category) => category.cents > 0)
  return { bars: spent.slice(0, CHART_BARS), leftOut: Math.max(0, spent.length - CHART_BARS) }
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
