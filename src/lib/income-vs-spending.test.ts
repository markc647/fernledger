import { describe, expect, it } from 'vitest'
import { partOfMonth } from './income-vs-spending'

describe('partOfMonth', () => {
  it('is null for a month the dates cover in full, however many months they cover', () => {
    expect(partOfMonth('2026-10', '2026-10-01', '2026-10-31')).toBeNull()
    expect(partOfMonth('2026-10', '2026-09-15', '2026-11-15')).toBeNull() // in the middle
    expect(partOfMonth('2028-02', '2028-02-01', '2028-02-29')).toBeNull() // the 29th of a leap year is the last day
    expect(partOfMonth('2027-02', '2027-02-01', '2027-02-28')).toBeNull() // and the 28th of any other year
  })

  it('names the dates counted in a month the range starts or ends part way through', () => {
    expect(partOfMonth('2026-10', '2026-10-15', '2026-12-31')).toBe('Thu 15 Oct 2026 to Sat 31 Oct 2026')
    expect(partOfMonth('2026-12', '2026-10-01', '2026-12-10')).toBe('Tue 1 Dec 2026 to Thu 10 Dec 2026')
    expect(partOfMonth('2026-10', '2026-10-05', '2026-10-20')).toBe('Mon 5 Oct 2026 to Tue 20 Oct 2026') // both ends in one month
  })

  it('names one date, not a range, when one day is counted', () => {
    expect(partOfMonth('2026-10', '2026-10-31', '2026-10-31')).toBe('Sat 31 Oct 2026')
    expect(partOfMonth('2028-02', '2028-02-29', '2028-03-31')).toBe('Tue 29 Feb 2028')
  })
})
