import { describe, expect, it } from 'vitest'
import { formatDate, formatSignedNzd } from './format'

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
