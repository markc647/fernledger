// How money and dates read on screen. Money is integer NZD cents and dates are NZ dates (Pacific/Auckland);
// every screen formats through here so they all read the same (README: Accessibility, "Plain language").

const MINUS = '−' // a real minus sign: a hyphen is too short to read as one, and screen readers say "dash"

const dollars = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' })

function dollarsFromCents(cents: number) {
  // The message never includes the value: amounts are private (CODING_STANDARDS.md, Security and privacy).
  if (!Number.isSafeInteger(cents)) throw new RangeError('Amounts are whole cents')
  return dollars.format(Math.abs(cents) / 100)
}

/** A Transaction's amount, always signed: "+$1,234.56" for money in, "−$1,234.56" for money out, "$0.00" for none. */
export function formatAmount(cents: number) {
  const text = dollarsFromCents(cents)
  return cents < 0 ? MINUS + text : cents > 0 ? `+${text}` : text
}

/** An Account balance: signed only when overdrawn, "−$50.00". */
export function formatBalance(cents: number) {
  const text = dollarsFromCents(cents)
  return cents < 0 ? MINUS + text : text
}

const dayFormat = (timeZone: string) =>
  new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone })

// Assembled from parts because en-NZ puts a comma after the weekday ("Thu, 8 Oct 2026"). NZ abbreviates September to "Sept".
const readDay = (format: Intl.DateTimeFormat, date: Date) =>
  format
    .formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join(' ')

const inNewZealand = dayFormat('Pacific/Auckland')
const asCalendarDate = dayFormat('UTC')

/** An NZ calendar date as stored ("2026-10-08"), such as a Transaction's date: "Thu 8 Oct 2026". Never shifted by a time zone. */
export function formatDate(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  // A date such as 30 February rolls over into March; reject it rather than show a different day.
  if (!match || date!.toISOString().slice(0, 10) !== isoDate) throw new RangeError('Dates are YYYY-MM-DD')
  return readDay(asCalendarDate, date!)
}

/** A moment in time (such as when a Sync last ran) shown as its New Zealand day: "Thu 8 Oct 2026". */
export function formatInstantDate(instant: Date | number) {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) throw new RangeError('Not a valid moment')
  return readDay(inNewZealand, date)
}

/** The plain-language direction of an amount; null for zero. Never "debit" or "credit". */
export function moneyLabel(cents: number) {
  return cents > 0 ? 'Money in' : cents < 0 ? 'Money out' : null
}
