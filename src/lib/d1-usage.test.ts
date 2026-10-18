import { describe, expect, it } from 'vitest'
import { allowanceLeft, FILL, LEVEL_WORDS, levelOf, meters, percentOf, resetSentence, TONE, unavailableNote, type D1Usage, type Level } from './d1-usage'

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
    expect(percentOf(3_499_999, 5_000_000)).toBe(69) // 69.99: not yet Running low
    expect(percentOf(3_500_000, 5_000_000)).toBe(70)
    expect(percentOf(4_999_999, 5_000_000)).toBe(99) // not 100 until the allowance really is used up
    expect(percentOf(5_000_000, 5_000_000)).toBe(100)
  })

  it('goes past 100 if the account has read more than the allowance', () => {
    expect(percentOf(5_250_000, 5_000_000)).toBe(105)
  })
})

// One scale for the Rules page's two bars and the header's one, so they never say different things of the same figures: amber from 70% used (30% left), red from 85% used (15% left),
// and "used up" only when the allowance has really been reached, and not when the percentage rounds to 100.
describe('plenty left, running low, almost used and used up', () => {
  it.each([
    [0, 'plenty'],
    [3_499_999, 'plenty'],
    [3_500_000, 'low'],
    [4_249_999, 'low'],
    [4_250_000, 'almost'],
    [4_999_999, 'almost'], // 99.99998%, which is not used up
    [5_000_000, 'used-up'],
    [5_250_000, 'used-up'],
  ] as const)('puts %i of the 5,000,000 rows read at %s', (used, level) => {
    expect(levelOf(used, 5_000_000)).toBe(level)
  })

  it.each([
    [69_999, 'plenty'],
    [70_000, 'low'],
    [85_000, 'almost'],
    [99_999, 'almost'],
    [100_000, 'used-up'],
  ] as const)('puts %i of the 100,000 rows written at %s', (used, level) => {
    expect(levelOf(used, 100_000)).toBe(level)
  })

  it('has words that say how much is left or gone, and none that means the other thing: a bar that is Low is not the one with little used', () => {
    expect(LEVEL_WORDS).toEqual({ plenty: 'Plenty left', low: 'Running low', almost: 'Almost used', 'used-up': 'Used up' })
    expect(Object.values(LEVEL_WORDS)).not.toContain('Low')
  })

  it('has green for plenty, amber for running low and red for almost used and used up', () => {
    expect(TONE).toEqual({ plenty: 'success', low: 'warning', almost: 'danger', 'used-up': 'danger' })
    expect(Object.keys(FILL)).toEqual(['plenty', 'low', 'almost', 'used-up'])
    expect(FILL.plenty).toContain('bg-success')
    expect(FILL.low).toContain('bg-warning')
    expect(FILL.almost).toContain('bg-danger')
    expect(FILL['used-up']).toContain('bg-danger')
    for (const classes of Object.values(FILL)) expect(classes).toContain('forced-colors:bg-[CanvasText]')
  })
})

describe('what the Admin reads on the Rules page', () => {
  it('gives the rows read first, with the thousands marked, the percentage, and the level from the same figures', () => {
    const [reads] = meters(usage())
    expect(reads).toEqual({
      label: 'Database rows read today',
      level: 'plenty',
      percent: 24,
      text: '1,234,567 of 5,000,000 rows read · 24%',
      valueText: '1,234,567 of 5,000,000 rows read, 24%',
    })
  })

  it('then the rows written, against their own, much smaller, allowance', () => {
    const [, writes] = meters(usage({ rowsWritten: 85_001 }))
    expect(writes).toEqual({
      label: 'Database rows written today',
      level: 'almost',
      percent: 85,
      text: '85,001 of 100,000 rows written · 85%',
      valueText: '85,001 of 100,000 rows written, 85%',
    })
  })

  it('says it is used up only when it is, with a percentage past 100 when it has gone over', () => {
    expect(meters(usage({ rowsRead: 5_100_000 }))[0]).toMatchObject({ level: 'used-up', percent: 102, text: '5,100,000 of 5,000,000 rows read · 102%' })
    expect(meters(usage({ rowsRead: 4_999_999 }))[0]).toMatchObject({ level: 'almost', percent: 99 })
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

// The header's one bar (src/components/allowance-bar.tsx): how much of today is left of whichever allowance has gone further.
describe('the allowance left, for the header', () => {
  it('is the whole per cent left of the allowance that has less, rounded down so it is never more than is left', () => {
    expect(allowanceLeft(usage())).toMatchObject({ percent: 75 }) // 3,765,433 of 5,000,000 is 75.3; the 4,321 written leave 95
    expect(allowanceLeft(usage({ rowsRead: 4_999_999 }))).toMatchObject({ percent: 0 }) // not 1 while there is less than one in a hundred
    expect(allowanceLeft(usage({ rowsRead: 0, rowsWritten: 0 }))).toMatchObject({ percent: 100 })
  })

  it('takes the rows written when they leave less than the rows read, and says the same as the Rules page for it', () => {
    expect(allowanceLeft(usage({ rowsWritten: 60_000 }))).toMatchObject({ percent: 40, level: 'plenty' })
    expect(allowanceLeft(usage({ rowsWritten: 90_000 }))).toMatchObject({ percent: 10, level: 'almost', word: 'Almost used' })
    expect(allowanceLeft(usage({ rowsRead: 2_500_000, rowsWritten: 50_000 }))).toMatchObject({ percent: 50 }) // the same left of each
  })

  it('is 0 when the account has used more than the allowance, not less than nothing', () => {
    expect(allowanceLeft(usage({ rowsRead: 5_250_000 })).percent).toBe(0)
    expect(allowanceLeft(usage({ rowsWritten: 100_001 })).percent).toBe(0)
  })

  it('says Plenty left until 70% is used (30% left), Running low from there and Almost used from 85% used (15% left), in words as well as colour, as the Rules page does', () => {
    const at = (used: number) => allowanceLeft(usage({ rowsRead: used, rowsWritten: 0 }))
    expect(at(0)).toMatchObject({ percent: 100, level: 'plenty', word: 'Plenty left' })
    expect(at(3_499_999)).toMatchObject({ percent: 30, level: 'plenty', word: 'Plenty left' }) // 30.00002% is left: 69.99998% is used, so not yet
    expect(at(3_500_000)).toMatchObject({ percent: 30, level: 'low', word: 'Running low' })
    expect(at(4_249_999)).toMatchObject({ percent: 15, level: 'low', word: 'Running low' })
    expect(at(4_250_000)).toMatchObject({ percent: 15, level: 'almost', word: 'Almost used' })
    expect(at(4_999_999)).toMatchObject({ percent: 0, level: 'almost', word: 'Almost used' }) // 0 is what is shown, and it is not used up
  })

  it('is Used up only when the allowance has been reached, however it is shown', () => {
    expect(allowanceLeft(usage({ rowsRead: 5_000_000 }))).toMatchObject({ percent: 0, level: 'used-up', word: 'Used up' })
    expect(allowanceLeft(usage({ rowsWritten: 100_000 }))).toMatchObject({ percent: 0, level: 'used-up', word: 'Used up' })
    expect(allowanceLeft(usage({ rowsRead: 4_999_999 })).word).toBe('Almost used')
  })

  // The header and the two bars of the Rules page are one scale: whichever the header goes by, the Rules page's bar for the same figures says the same thing.
  it('says what the Rules page says of the same figures', () => {
    const levels: Level[] = []
    for (const rowsRead of [0, 3_499_999, 3_500_000, 4_250_000, 4_999_999, 5_000_000]) {
      for (const rowsWritten of [0, 70_000, 85_000, 99_999, 100_000]) {
        const figures = usage({ rowsRead, rowsWritten })
        const [reads, writes] = meters(figures)
        const rank = { plenty: 0, low: 1, almost: 2, 'used-up': 3 } as const
        const worse = rank[writes.level] > rank[reads.level] ? writes : reads
        expect(allowanceLeft(figures).level).toBe(worse.level)
        levels.push(worse.level)
      }
    }
    expect(new Set(levels)).toEqual(new Set(['plenty', 'low', 'almost', 'used-up']))
  })

  it('says both figures, with the thousands marked, wherever it is read, and says it is an estimate', () => {
    const left = allowanceLeft(usage({ rowsRead: 4_100_000, rowsWritten: 4_321 })) // 18% of the reads left
    expect(left.figures).toEqual(['Rows read today: 4,100,000 of 5,000,000', 'Rows written today: 4,321 of 100,000'])
    expect(left.valueText).toBe('About 18% left, Running low. Rows read today: 4,100,000 of 5,000,000. Rows written today: 4,321 of 100,000. An estimate: Cloudflare runs a few minutes behind.')
    expect(allowanceLeft(usage()).valueText).toMatch(/^About 75% left, Plenty left\. Rows read today/) // the calm word too, so a screen reader hears the same as the Rules page says
  })
})
