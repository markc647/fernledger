const clockFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' })

/** The NZ calendar date (`YYYY-MM-DD`) a moment falls on. Pacific/Auckland, so a day turns over at NZ midnight, not UTC midnight. */
export const nzDate = (at: Date): string => dateFormat.format(at)

/** The date after `date`, both `YYYY-MM-DD`. */
export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

/**
 * The UTC instants at which the Pacific/Auckland clock reads `HH:MM` on an NZ date. NZ is UTC+12 or UTC+13, so those are the two to try:
 * none when the clocks skipped that time, one usually, and two when they went back over it.
 */
function instantsAt(date: string, time: string): Date[] {
  return [12, 13]
    .map((offsetHours) => new Date(Date.parse(`${date}T${time}:00Z`) - offsetHours * 3_600_000))
    .filter((instant) => clockFormat.format(instant).replace(',', '') === `${date} ${time}`)
}

/**
 * The UTC instant (ISO 8601, as stored in the Change Log) at which an NZ date begins in Pacific/Auckland.
 * Clocks change at 2 am or 3 am, so midnight always exists, and once.
 */
export function nzDayStart(date: string): string {
  const [start] = instantsAt(date, '00:00')
  if (!start) throw new Error('No NZ midnight for that date')
  return start.toISOString()
}

/**
 * The UTC instant (ISO 8601) of a wall-clock time (`HH:MM`) on an NZ date, or null when NZ had no such time (clocks went forward
 * past it) or had it twice (clocks went back), because then the instant is a guess and Fernledger does not guess.
 */
export function nzClockTime(date: string, time: string): string | null {
  const instants = instantsAt(date, time)
  return instants.length === 1 ? instants[0]!.toISOString() : null
}
