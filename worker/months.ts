// NZ calendar months, written 'YYYY-MM': what a Budget is "effective from", and what spending is grouped by.
// A Transaction's date is already an NZ date (AGENTS.md: dates are NZ dates), so its month is its first seven characters
// and needs no time zone. Only "this month" is a moment in time, and it is read through nz-time.ts.
import { MAX_QUERY_DATE, MIN_QUERY_DATE } from './dates'
import { nzDate } from './nz-time'

/** The months a Budget can be effective from: the years a date search accepts (dates.ts). */
export const MIN_MONTH = MIN_QUERY_DATE.slice(0, 7)
export const MAX_MONTH = MAX_QUERY_DATE.slice(0, 7)

/** Whether `value` is a month written `YYYY-MM` within the years Fernledger accepts. */
export const isMonth = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= MIN_MONTH && value <= MAX_MONTH

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "October 2026", for the Change Log and the pages. Written out in full, so there is no short form to disagree about. */
export const monthLabel = (month: string) => `${NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`

/** The first day of the month, `YYYY-MM-DD`. */
export const monthStart = (month: string) => `${month}-01`

/** The last day of the month, `YYYY-MM-DD`. */
export const monthEnd = (month: string) => `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}`

/** The month after `month`, across the end of a year. */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  return number === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${month.slice(0, 5)}${String(number + 1).padStart(2, '0')}`
}

/** The NZ calendar month a moment falls in (Pacific/Auckland, so a month changes at NZ midnight, not UTC midnight). */
export const nzMonth = (at: Date): string => nzDate(at).slice(0, 7)
