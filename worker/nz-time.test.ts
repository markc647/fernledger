import { describe, expect, it } from 'vitest'
import { nextDay, nzDayStart } from './nz-time'

describe('nzDayStart', () => {
  it.each([
    ['2026-10-08', '2026-10-07T11:00:00.000Z'], // summer time, UTC+13
    ['2026-07-01', '2026-06-30T12:00:00.000Z'], // winter time, UTC+12
    ['2026-09-27', '2026-09-26T12:00:00.000Z'], // the day clocks go forward: it begins on winter time
    ['2026-09-28', '2026-09-27T11:00:00.000Z'],
    ['2026-04-05', '2026-04-04T11:00:00.000Z'], // the day clocks go back: it begins on summer time
    ['2026-04-06', '2026-04-05T12:00:00.000Z'],
    ['2026-12-31', '2026-12-30T11:00:00.000Z'],
    ['2027-01-01', '2026-12-31T11:00:00.000Z'],
  ])('starts NZ date %s at %s', (date, utc) => {
    expect(nzDayStart(date)).toBe(utc)
  })
})

describe('nextDay', () => {
  it.each([
    ['2026-10-08', '2026-10-09'],
    ['2026-10-31', '2026-11-01'],
    ['2026-12-31', '2027-01-01'],
    ['2028-02-28', '2028-02-29'],
  ])('%s is followed by %s', (date, next) => {
    expect(nextDay(date)).toBe(next)
  })
})
