import { isoDateParts } from './iso-date'

// The years a search by date accepts: the Change Log and the Transactions list send dates the API checks against the same
// bounds (worker/dates.ts), and a date picker offers no others. An address typed by hand can hold any year; those aren't searched.
export const MIN_DATE = '2000-01-01'
export const MAX_DATE = '2100-12-31'

/** Whether `date` ("" for none) is outside the years the API accepts. */
const outOfRange = (date: string) => date !== '' && (date < MIN_DATE || date > MAX_DATE)

/** Whether `value` is a real date written YYYY-MM-DD, within the years the API accepts. */
export function isSearchDate(value: string) {
  return isoDateParts(value) !== undefined && !outOfRange(value)
}

/** The last day of an NZ calendar month ("2026-10"), as two digits: "31". */
export const lastDay = (month: string) => String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')
