// The years a search by date accepts: the Change Log and the Transactions list send dates the API checks against the same
// bounds (worker/dates.ts). A date input emits partial years (0002, then 0020...) while one is typed; those aren't searched.
export const MIN_DATE = '2000-01-01'
export const MAX_DATE = '2100-12-31'

/** Whether `date` ("" for none) is outside the years the API accepts. */
export const outOfRange = (date: string) => date !== '' && (date < MIN_DATE || date > MAX_DATE)

/** Whether `value` is a real date written YYYY-MM-DD, within the years the API accepts. */
export function isSearchDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match || outOfRange(value)) return false
  // A date such as 30 February rolls over into March in Date; compare it back.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === value
}
