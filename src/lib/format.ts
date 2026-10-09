const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An NZ calendar date (`YYYY-MM-DD`) as "Thu 8 Oct 2026". Worked out in UTC so the device's time zone can't shift it. */
export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number]
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}`
}

const nzClock = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/** A moment (ISO 8601, UTC) as NZ time: "Thu 8 Oct 2026, 3:42 pm". Always Pacific/Auckland, whatever the device's time zone. */
export function formatDateTime(isoInstant: string): string {
  const part = Object.fromEntries(nzClock.formatToParts(new Date(isoInstant)).map(({ type, value }) => [type, value]))
  return `${formatDate(`${part.year}-${part.month}-${part.day}`)}, ${part.hour}:${part.minute} ${part.dayPeriod?.toLowerCase()}`
}

const dollars = new Intl.NumberFormat('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Integer NZD cents with a sign: "+$1.20" for money in, "-$8.20" for money out. */
export function formatSignedNzd(cents: number): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '-' : ''
  return `${sign}$${dollars.format(Math.abs(cents) / 100)}`
}
