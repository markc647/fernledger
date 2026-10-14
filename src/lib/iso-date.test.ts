import { describe, expect, it } from 'vitest'
import { isoDateParts } from './iso-date'

describe('isoDateParts (a stored date, if it is one)', () => {
  it('reads the year, the month from 1 and the day', () => {
    expect(isoDateParts('2026-10-08')).toEqual({ year: 2026, month: 10, day: 8 })
  })

  it.each(['2000-02-29', '2024-02-29', '2028-02-29', '2000-01-01', '2100-12-31', '1000-01-01', '0500-06-15', '0100-01-01'])('accepts %s', (date) => {
    expect(isoDateParts(date)).toBeDefined()
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
    ['a year below 100, which Date would read as another year', '0099-01-01'],
    ['a date with a time', '2026-10-08T00:00:00Z'],
    ['spaces around it', ' 2026-10-08'],
    ['slashes', '2026/10/08'],
    ['the NZ written form', '8/10/2026'],
  ])('is nothing for %s', (_why, date) => {
    expect(isoDateParts(date)).toBeUndefined()
  })
})
