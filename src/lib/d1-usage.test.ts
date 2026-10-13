import { describe, expect, it } from 'vitest'
import { barValue, levelOf, LEVEL_WORDS, meters, percentOf, resetSentence, setupPointer, staleNote, unavailableNote, type D1Usage } from './d1-usage'

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

  it('goes past 100 if the account has read more than the allowance, and the bar stops at the end', () => {
    expect(percentOf(5_250_000, 5_000_000)).toBe(105)
    expect(barValue(105)).toBe(100)
    expect(barValue(24)).toBe(24)
    expect(barValue(0)).toBe(0)
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

  it('has the words, which are what carries the level for a reader who cannot see the colour', () => {
    expect(LEVEL_WORDS).toEqual({ low: 'Low', medium: 'Medium', high: 'High' })
  })
})

describe('what the Admin reads', () => {
  it('gives the rows read first, with the thousands marked, the percentage, and the level from the same percentage', () => {
    const [reads] = meters(usage())
    expect(reads).toMatchObject({
      label: 'D1 rows read today',
      level: 'low',
      percent: 24,
      value: 24,
      text: '1,234,567 of 5,000,000 rows read · 24%',
      valueText: '1,234,567 of 5,000,000 rows read, 24%',
    })
  })

  it('then the rows written, against their own, much smaller, allowance', () => {
    const [, writes] = meters(usage({ rowsWritten: 85_001 }))
    expect(writes).toMatchObject({
      label: 'D1 rows written today',
      level: 'high',
      percent: 85,
      text: '85,001 of 100,000 rows written · 85%',
      valueText: '85,001 of 100,000 rows written, 85%',
    })
  })

  it('says what it says when the day is used up, and does not draw past the end of the bar', () => {
    const [reads] = meters(usage({ rowsRead: 5_100_000 }))
    expect(reads).toMatchObject({ level: 'high', percent: 102, value: 100, text: '5,100,000 of 5,000,000 rows read · 102%' })
  })

  it('says when the allowance starts again, in New Zealand time', () => {
    expect(resetSentence(usage())).toBe('The allowance starts again on Thu 15 Oct 2026, 1:00 pm, New Zealand time.')
    // In winter, 00:00 UTC is midday.
    expect(resetSentence(usage({ resetsAt: '2026-07-02T00:00:00.000Z' }))).toBe('The allowance starts again on Thu 2 Jul 2026, 12:00 pm, New Zealand time.')
  })

  it('says the figures are for the whole account and a few minutes behind', () => {
    expect(staleNote()).toBe('These figures are for the whole Cloudflare account, not only Fernledger, and run a few minutes behind.')
  })

  it('says where the steps to turn it on are, by the heading docs/setup.md has', () => {
    expect(setupPointer()).toBe('The steps are in docs/setup.md, under "D1 usage bar (optional)".')
  })

  it('says, when Cloudflare cannot give them, that they are unavailable and where to look', () => {
    expect(unavailableNote()).toBe(
      'Usage unavailable. Cloudflare did not give the figures just now. If this keeps happening, check the token and account ID you set. The steps are in docs/setup.md, under "D1 usage bar (optional)".',
    )
  })
})
