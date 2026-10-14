import { isoDateParts } from './iso-date.ts' // with its extension, because scripts/calendar-day.test.mjs runs this file in Node

// A calendar picker hands over and takes Dates; Fernledger stores NZ calendar dates as "2026-10-08" (AGENTS.md: dates are NZ dates). A calendar date has no time
// zone, so the two are converted by year, month and day alone: never `new Date("2026-10-08")` or `toISOString()`, which count in UTC and move the day by one for
// anyone east or west of it. A day is the middle of its day, where no change of the clocks (NZ summer time begins 2 am to 3 am on the last Sunday of September, and
// ends 3 am to 2 am on the first Sunday of April) can put it on another date. Which day is "today" in NZ is `nzDate` in format.ts, not this device's clock.

/** A stored date ("2026-10-08") as the day a calendar shows, or undefined for "" and for anything that is not a real date (see `isoDateParts`). */
export function dayOf(isoDate: string): Date | undefined {
  const parts = isoDateParts(isoDate)
  return parts && new Date(parts.year, parts.month - 1, parts.day, 12)
}

/** A calendar's day as a stored date ("2026-10-08"), from its year, month and day as this device counts them and not its time of day. */
export function isoDateOf(day: Date) {
  return `${String(day.getFullYear()).padStart(4, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

const firstOfMonth = (day: Date) => {
  const first = new Date(day)
  first.setDate(1)
  return first
}

/**
 * The months a calendar's month and year dropdowns offer: from the month of the first date to the month of the last, each as the first of that month. The date a
 * field already holds is always inside them, even when it is outside the range, so the calendar can show it.
 */
export function monthsToShow(min: string, max: string, held: string) {
  const first = dayOf(min)
  const last = dayOf(max)
  if (!first || !last) throw new RangeError('Dates are YYYY-MM-DD')
  const value = dayOf(held)
  const start = firstOfMonth(value && value < first ? value : first)
  const end = firstOfMonth(value && value > last ? value : last)
  return { start, end: end < start ? new Date(start) : end }
}
