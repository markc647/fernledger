import { describe, expect, it } from 'vitest'
import { SYNCED_WITHIN_MS, syncedInLast24Hours } from './akahu-sync'

const now = new Date('2026-10-16T01:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const before = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('syncedInLast24Hours', () => {
  it('is 24 hours, to the millisecond', () => {
    expect(SYNCED_WITHIN_MS).toBe(DAY)
  })

  it('is true for a Sync a moment ago, and for one just now', () => {
    expect(syncedInLast24Hours(before(1000), now)).toBe(true)
    expect(syncedInLast24Hours(before(0), now)).toBe(true)
  })

  it('counts exactly 24 hours ago as in the last 24 hours, and a millisecond more as not', () => {
    expect(syncedInLast24Hours(before(DAY - 1), now)).toBe(true)
    expect(syncedInLast24Hours(before(DAY), now)).toBe(true)
    expect(syncedInLast24Hours(before(DAY + 1), now)).toBe(false)
  })

  it('is false for an Account Sync has never reached', () => {
    expect(syncedInLast24Hours(null, now)).toBe(false)
  })

  it('is false for a time in the future: it is not a Sync that has happened', () => {
    expect(syncedInLast24Hours(before(-1), now)).toBe(false)
    expect(syncedInLast24Hours('2099-01-01T00:00:00.000Z', now)).toBe(false)
  })

  it('is false for anything that is not an instant in UTC, so a bad value shows as Not Synced and not as fine', () => {
    for (const bad of ['', 'yesterday', '2026-10-15', '2026-10-15T01:00:00', '2026-10-15T01:00:00+13:00', '2026-13-45T25:61:61.000Z', 'NaN']) {
      expect(syncedInLast24Hours(bad, now), bad).toBe(false)
    }
  })

  it('reads an instant with or without milliseconds', () => {
    expect(syncedInLast24Hours('2026-10-15T01:00:00Z', now)).toBe(true) // exactly 24 hours
    expect(syncedInLast24Hours('2026-10-15T00:59:59Z', now)).toBe(false)
    expect(syncedInLast24Hours('2026-10-15T01:00:00.000Z', now)).toBe(true)
  })
})
