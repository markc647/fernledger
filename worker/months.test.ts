import { describe, expect, it } from 'vitest'
import { isMonth, monthLabel, monthStart, nextMonth, nzMonth } from './months'

describe('isMonth', () => {
  it.each(['2026-10', '2000-01', '2100-12', '2026-02'])('accepts %s', (value) => {
    expect(isMonth(value)).toBe(true)
  })

  it.each(['1999-12', '2101-01', '2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '2026/10', ' 2026-10', '', 'October', 202610, null, undefined])('refuses %j', (value) => {
    expect(isMonth(value)).toBe(false)
  })
})

describe('monthLabel', () => {
  it.each([
    ['2026-10', 'October 2026'],
    ['2026-09', 'September 2026'],
    ['2027-01', 'January 2027'],
    ['2026-12', 'December 2026'],
  ])('writes %s as %s', (month, label) => {
    expect(monthLabel(month)).toBe(label)
  })
})

describe('monthStart and nextMonth', () => {
  it('give the first day of a month and the month after, across the end of a year', () => {
    expect(monthStart('2026-10')).toBe('2026-10-01')
    expect(nextMonth('2026-10')).toBe('2026-11')
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(nextMonth('2026-09')).toBe('2026-10')
  })
})

describe('nzMonth', () => {
  // NZ is UTC+13 in summer (clocks forward on 27 Sept 2026) and UTC+12 in winter, so a month changes at 11:00 or 12:00 UTC the day before.
  it.each([
    ['2026-09-30T10:59:59Z', '2026-09'], // 23:59:59 on 30 Sept, summer time
    ['2026-09-30T11:00:00Z', '2026-10'], // midnight, 1 Oct
    ['2026-06-30T11:59:59Z', '2026-06'], // 23:59:59 on 30 June, winter time
    ['2026-06-30T12:00:00Z', '2026-07'],
    ['2026-12-31T10:59:59Z', '2026-12'],
    ['2026-12-31T11:00:00Z', '2027-01'], // a new year in NZ, still the old one in UTC
    ['2026-10-31T11:30:00Z', '2026-11'], // still 31 Oct in UTC, 1 Nov in NZ
    ['2026-10-10T03:00:00Z', '2026-10'],
  ])('puts %s in NZ month %s', (instant, month) => {
    expect(nzMonth(new Date(instant))).toBe(month)
  })
})
