import { describe, expect, it } from 'vitest'
import { dayOf, isoDateOf, monthsToShow } from './calendar-day'

// The tests run in a runtime whose time zone is UTC. That every date goes to a day and back as itself in the zones where counting in UTC would move it (NZ, UTC+14, UTC-11, the
// days NZ's clocks change) is scripts/calendar-day.test.mjs. What is a real date is iso-date.test.ts.

describe('dayOf (a stored date as a calendar day)', () => {
  it('reads year, month and day, with the month counted from zero as Date does', () => {
    const day = dayOf('2026-10-08')!
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 9, 8])
  })

  it.each(['', '2026-02-30', '2026-13-01', '8/10/2026', '0099-01-01'])('is nothing for %j', (date) => {
    expect(dayOf(date)).toBeUndefined()
  })
})

describe('isoDateOf (a calendar day as a stored date)', () => {
  it('writes the local year, month and day with their zeros, and not the time of day', () => {
    expect(isoDateOf(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isoDateOf(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31')
    expect(isoDateOf(new Date(2026, 9, 8, 0, 0, 0, 0))).toBe('2026-10-08')
  })

  it('writes a year below 1000 with four digits', () => {
    const day = new Date(2000, 0, 1)
    day.setFullYear(999, 0, 2)
    expect(isoDateOf(day)).toBe('0999-01-02')
  })
})

describe('monthsToShow (the months the dropdowns offer)', () => {
  it('runs from the month of the first day to the month of the last', () => {
    const { start, end } = monthsToShow('2000-01-01', '2100-12-31', '')
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2000, 0, 1])
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2100, 11, 1])
  })

  it('starts on the first of the month when the first day is part way through it', () => {
    const { start, end } = monthsToShow('2026-10-09', '2027-03-15', '')
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 9, 1])
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2027, 2, 1])
  })

  it('widens to take in a value that is outside the range, so what is shown can be found in the dropdowns', () => {
    expect(isoDateOf(monthsToShow('2000-01-01', '2100-12-31', '1999-06-15').start)).toBe('1999-06-01')
    expect(isoDateOf(monthsToShow('2000-01-01', '2100-12-31', '2101-02-03').end)).toBe('2101-02-01')
  })

  it('ignores a value that is not a date', () => {
    expect(isoDateOf(monthsToShow('2000-01-01', '2100-12-31', '2026-02-30').start)).toBe('2000-01-01')
    expect(isoDateOf(monthsToShow('2000-01-01', '2100-12-31', '').end)).toBe('2100-12-01')
  })

  it('never ends before it starts, even when the bounds cross', () => {
    const { start, end } = monthsToShow('2026-10-09', '2026-10-01', '')
    expect(isoDateOf(start)).toBe('2026-10-01')
    expect(isoDateOf(end)).toBe('2026-10-01')
  })
})
