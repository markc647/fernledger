const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether `value` is an NZ calendar date written `YYYY-MM-DD` that exists (not 30 February). Shared by the Import rows and the Account fields. */
export const isRealDate = (value: unknown) => {
  const parts = typeof value === 'string' ? ISO_DATE.exec(value) : null
  if (!parts) return false
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (month < 1 || month > 12 || day < 1) return false
  const year = Number(parts[1])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= (month === 2 && !leap ? 28 : DAYS_IN_MONTH[month - 1]!)
}

// The years a search by date accepts. Bounded so nzDayStart and nextDay never see a year they can't handle (a date input
// emits partial years such as 0002 while one is typed). The browser's date inputs use the same bounds (src/lib/date-range.ts).
export const MIN_QUERY_DATE = '2000-01-01'
export const MAX_QUERY_DATE = '2100-12-31'

/** Whether `value` is a real NZ date within the years a search accepts. Shared by the Change Log and the Transactions list. */
export const isQueryDate = (value: unknown): value is string => isRealDate(value) && (value as string) >= MIN_QUERY_DATE && (value as string) <= MAX_QUERY_DATE
