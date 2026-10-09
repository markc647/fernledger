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
