import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatSignedNzd } from './format'

describe('formatDateTime', () => {
  it.each([
    ['2026-10-08T02:42:00.000Z', 'Thu 8 Oct 2026, 3:42 pm'], // summer time, UTC+13
    ['2026-07-01T00:05:00.000Z', 'Wed 1 Jul 2026, 12:05 pm'], // winter time, UTC+12
    ['2026-10-07T11:00:00.000Z', 'Thu 8 Oct 2026, 12:00 am'], // already the next day in NZ
    ['2026-10-07T10:59:59.999Z', 'Wed 7 Oct 2026, 11:59 pm'],
  ])('writes the moment %s in NZ time as "%s"', (iso, text) => {
    expect(formatDateTime(iso)).toBe(text)
  })
})

describe('formatDate', () => {
  it('writes an NZ date like "Thu 8 Oct 2026"', () => {
    expect(formatDate('2026-10-08')).toBe('Thu 8 Oct 2026')
    expect(formatDate('2019-10-31')).toBe('Thu 31 Oct 2019')
  })

  it('does not drift with the device time zone (it is a calendar date, not a moment)', () => {
    expect(formatDate('2026-01-01')).toBe('Thu 1 Jan 2026')
    expect(formatDate('2026-12-31')).toBe('Thu 31 Dec 2026')
  })
})

describe('formatSignedNzd', () => {
  it.each([
    [-820, '-$8.20'],
    [120, '+$1.20'],
    [250050, '+$2,500.50'],
    [-123450, '-$1,234.50'],
    [0, '$0.00'],
    [-5, '-$0.05'],
  ])('shows %i cents as %s', (cents, text) => {
    expect(formatSignedNzd(cents)).toBe(text)
  })
})
