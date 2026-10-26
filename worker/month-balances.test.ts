import { describe, expect, it } from 'vitest'
import { carryForward } from './month-balances'

describe('carryForward', () => {
  const months = (entries: [string, number][]) => new Map(entries)

  it('is the last balance of each month, and the balance before it for a month with none', () => {
    expect(carryForward(months([['2026-07', 14_000], ['2026-08', 12_000], ['2026-10', 12_300]]), '2026-07', '2026-10', 10_000)).toEqual([14_000, 12_000, 12_000, 12_300])
  })

  it('starts from the opening balance when the first month has none, and repeats it until a month has one', () => {
    expect(carryForward(months([['2026-09', 49_223]]), '2026-07', '2026-10', 50_000)).toEqual([50_000, 50_000, 49_223, 49_223])
  })

  it('is one balance for one month', () => {
    expect(carryForward(months([['2026-10', 500]]), '2026-10', '2026-10', 100)).toEqual([500])
    expect(carryForward(months([]), '2026-10', '2026-10', 100)).toEqual([100])
  })

  it('runs across the end of a year, and ignores months outside the range', () => {
    expect(carryForward(months([['2026-11', 1], ['2026-12', 2], ['2027-02', 4], ['2028-01', 99]]), '2026-12', '2027-02', 0)).toEqual([2, 2, 4])
  })

  it('is nothing when the end is before the start', () => {
    expect(carryForward(months([['2026-10', 1]]), '2026-10', '2026-09', 0)).toEqual([])
  })
})
