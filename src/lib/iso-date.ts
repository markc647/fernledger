// What a stored date is: an NZ calendar date written YYYY-MM-DD ("2026-10-08") that exists. One place says so, for the display of a date (format.ts), a search's dates
// (date-range.ts) and the calendar picker (calendar-day.ts). The Worker keeps its own copy (worker/dates.ts), which is a separate program.

const STORED = /^(\d{4})-(\d{2})-(\d{2})$/
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * The year, month (1 to 12) and day of a stored date, or undefined for anything else: "", "8 Oct 2026", a month 13, 30 February. A year before 100 is not one either, because
 * Date reads the years 0 to 99 as 1900 to 1999. (The Worker takes any real date, so an Import or a Cutover Date can hold a year such as 0500, and it is shown as it is.)
 */
export function isoDateParts(value: string) {
  const match = STORED.exec(value)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 100 || month < 1 || month > 12 || day < 1) return undefined
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= (month === 2 && !leap ? 28 : DAYS_IN_MONTH[month - 1]!) ? { year, month, day } : undefined
}
