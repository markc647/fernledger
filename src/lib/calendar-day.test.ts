import { describe, expect, it } from 'vitest'
import { dayOf, isoDateOf, monthsToShow } from './calendar-day'

// The tests run in a runtime whose time zone is UTC; scripts/calendar-day.test.mjs runs the same conversions under other zones, which is where a shift would show.

describe('dayOf (a stored date as a calendar day)', () => {
  it('reads year, month and day, with the month counted from zero as Date does', () => {
    const day = dayOf('2026-10-08')!
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 9, 8])
  })

  it('is the middle of the day, so no hour of change in the clocks can move it to another day', () => {
    expect(dayOf('2026-09-27')!.getHours()).toBe(12) // NZ summer time begins: 2 am becomes 3 am
    expect(dayOf('2026-04-05')!.getHours()).toBe(12) // NZ summer time ends: 3 am becomes 2 am
  })

  it.each(['2000-02-29', '2024-02-29', '2028-02-29', '2026-12-31', '2026-01-01', '2100-12-31'])('reads %s as itself', (date) => {
    expect(isoDateOf(dayOf(date)!)).toBe(date)
  })

  it.each([
    ['30 February', '2026-02-30'],
    ['29 February in a year that is not a leap year', '2026-02-29'],
    ['29 February 2100, a century that is not a leap year', '2100-02-29'],
    ['month 13', '2026-13-01'],
    ['month 0', '2026-00-10'],
    ['day 0', '2026-10-00'],
    ['31 September', '2026-09-31'],
    ['an empty string', ''],
    ['a month without its zero', '2026-1-01'],
    ['a day without its zero', '2026-10-8'],
    ['a two-digit year', '26-10-08'],
    ['a date with a time', '2026-10-08T00:00:00Z'],
    ['spaces around it', ' 2026-10-08'],
    ['slashes', '2026/10/08'],
    ['the NZ written form', '8/10/2026'],
  ])('is nothing for %s', (_why, date) => {
    expect(dayOf(date)).toBeUndefined()
  })

  it('keeps a year below 100 as written, not as 19xx', () => {
    expect(dayOf('0099-01-01')!.getFullYear()).toBe(99)
    expect(isoDateOf(dayOf('0099-01-01')!)).toBe('0099-01-01')
  })
})

describe('isoDateOf (a calendar day as a stored date)', () => {
  it('writes the local year, month and day with their zeros', () => {
    expect(isoDateOf(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isoDateOf(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('does not look at the time of day: the first and last moments of a day are the same day', () => {
    expect(isoDateOf(new Date(2026, 9, 8, 0, 0, 0, 0))).toBe('2026-10-08')
    expect(isoDateOf(new Date(2026, 9, 8, 23, 59, 59, 999))).toBe('2026-10-08')
  })

  it('writes a day of the picker the way the picker would hand it back, at any time of day', () => {
    for (const hour of [0, 1, 11, 12, 13, 23]) expect(isoDateOf(new Date(2026, 8, 27, hour))).toBe('2026-09-27')
  })

  it('writes a year below 1000 with four digits', () => {
    const day = new Date(2000, 0, 1)
    day.setFullYear(999, 0, 2)
    expect(isoDateOf(day)).toBe('0999-01-02')
  })
})

describe('every day of two years comes back as itself', () => {
  it('goes from a stored date to a day and back, with 2028 a leap year', () => {
    let count = 0
    for (const year of [2027, 2028]) {
      for (let month = 1; month <= 12; month++) {
        for (let dayOfMonth = 1; dayOfMonth <= new Date(Date.UTC(year, month, 0)).getUTCDate(); dayOfMonth++) {
          const date = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`
          expect(isoDateOf(dayOf(date)!)).toBe(date)
          count++
        }
      }
    }
    expect(count).toBe(365 + 366)
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
