import { describe, expect, it } from 'vitest'
import { levelOf, meters, percentOf, resetSentence, unavailableNote, type D1Usage } from './d1-usage'

const usage = (over: Partial<D1Usage> = {}): D1Usage => ({
  rowsRead: 1_234_567,
  rowsWritten: 4_321,
  readLimit: 5_000_000,
  writeLimit: 100_000,
  resetsAt: '2026-10-15T00:00:00.000Z',
  ...over,
})

describe('the percentage', () => {
  it('rounds down, so a day is never shown as further gone than it is', () => {
    expect(percentOf(1_234_567, 5_000_000)).toBe(24) // 24.69
    expect(percentOf(0, 5_000_000)).toBe(0)
    expect(percentOf(3_999_999, 5_000_000)).toBe(79) // 79.99: not yet High
    expect(percentOf(4_000_000, 5_000_000)).toBe(80)
    expect(percentOf(4_999_999, 5_000_000)).toBe(99) // not 100 until the allowance really is used up
    expect(percentOf(5_000_000, 5_000_000)).toBe(100)
  })

  it('goes past 100 if the account has read more than the allowance', () => {
    expect(percentOf(5_250_000, 5_000_000)).toBe(105)
  })
})

describe('Low, Medium and High', () => {
  it.each([
    [0, 'low'],
    [49, 'low'],
    [50, 'medium'],
    [79, 'medium'],
    [80, 'high'],
    [100, 'high'],
    [105, 'high'],
  ] as const)('puts %i%% at %s', (percent, level) => {
    expect(levelOf(percent)).toBe(level)
  })
})

describe('what the Admin reads', () => {
  it('gives the rows read first, with the thousands marked, the percentage, and the level from the same percentage', () => {
    const [reads] = meters(usage())
    expect(reads).toEqual({
      label: 'Database rows read today',
      level: 'low',
      percent: 24,
      text: '1,234,567 of 5,000,000 rows read · 24%',
      valueText: '1,234,567 of 5,000,000 rows read, 24%',
    })
  })

  it('then the rows written, against their own, much smaller, allowance', () => {
    const [, writes] = meters(usage({ rowsWritten: 85_001 }))
    expect(writes).toEqual({
      label: 'Database rows written today',
      level: 'high',
      percent: 85,
      text: '85,001 of 100,000 rows written · 85%',
      valueText: '85,001 of 100,000 rows written, 85%',
    })
  })

  it('says what it says when the day is used up, with a percentage past 100', () => {
    const [reads] = meters(usage({ rowsRead: 5_100_000 }))
    expect(reads).toMatchObject({ level: 'high', percent: 102, text: '5,100,000 of 5,000,000 rows read · 102%' })
  })

  it('says when the allowance starts again, in New Zealand time', () => {
    expect(resetSentence(usage())).toBe('The allowance starts again on Thu 15 Oct 2026, 1:00 pm, New Zealand time.')
    // In winter, 00:00 UTC is midday.
    expect(resetSentence(usage({ resetsAt: '2026-07-02T00:00:00.000Z' }))).toBe('The allowance starts again on Thu 2 Jul 2026, 12:00 pm, New Zealand time.')
  })
})

describe('why there are no figures', () => {
  it('names the likely fix when Cloudflare refused the token or found no such account', () => {
    for (const reason of ['refused', 'no-account']) {
      const note = unavailableNote(reason)
      expect(note).toMatch(/^Usage unavailable\./)
      expect(note).toContain('CF_ACCOUNT_ID must be the account the token belongs to, and the token needs Account Analytics: Read.')
    }
    expect(unavailableNote('refused')).not.toBe(unavailableNote('no-account'))
  })

  it('does not send the Admin to the token when the trouble is Cloudflare being slow or odd', () => {
    for (const reason of ['unreachable', 'unreadable']) {
      expect(unavailableNote(reason)).toMatch(/^Usage unavailable\./)
      expect(unavailableNote(reason)).not.toContain('CF_ACCOUNT_ID')
    }
  })

  it('reads a reason it does not know, or none, as the plainest one', () => {
    expect(unavailableNote('something-new')).toBe(unavailableNote('unreachable'))
    expect(unavailableNote(undefined)).toBe(unavailableNote('unreachable'))
    // Not a property of the table's prototype.
    expect(unavailableNote('toString')).toBe(unavailableNote('unreachable'))
  })
})
