import { describe, expect, it } from 'vitest'
import { describeStop, type Stop } from './import-stop'

const stop: Stop = { sent: 2, total: 5, replacing: false, removed: 0, dailyLimit: false }

describe('describeStop', () => {
  it('says how many parts were saved, and that a plain Import loses nothing', () => {
    expect(describeStop(stop)).toEqual({
      headline: 'The Import stopped after 2 of 5 parts were saved.',
      happened: null,
      kept: null,
      next: 'Nothing is lost. Choose the same file again and import it: rows already saved are recognised and skipped.',
    })
  })

  it('leaves out the part count when none is known', () => {
    expect(describeStop({ ...stop, sent: 0, total: 0 }).headline).toBe('The Import stopped.')
  })

  it('says the daily limit was reached, and to try again tomorrow, not the generic stop', () => {
    const result = describeStop({ ...stop, dailyLimit: true })
    expect(result.headline).toBe('Daily limit reached. Try again tomorrow.')
    expect(result.next).toContain('tomorrow')
  })

  it('says part of the old history has been removed, for a replace that stopped while clearing it, and to use Replace again', () => {
    const result = describeStop({ sent: 0, total: 3, replacing: true, removed: 5000, dailyLimit: true })
    expect(result.happened).toBe('Part of the old history has been removed.')
    expect(result.kept).toContain('Any Override or Note you set on the removed Transactions is kept')
    expect(result.next).toContain('use "Replace imported history"')
    expect(result.next).toContain('tomorrow')
  })

  it('says the old history is gone once a part of the new file was saved, and that a plain Import finishes it', () => {
    const result = describeStop({ sent: 1, total: 3, replacing: true, removed: 40, dailyLimit: false })
    expect(result.happened).toBe('The old history has been removed and part of the new file is saved.')
    expect(result.kept).toContain('It is carried over to the Transaction with the same number from the bank when the file is imported, and what has no match stays until you discard it.')
    expect(result.next).toContain('import it: rows already saved are recognised and skipped')
  })

  it('says nothing was removed when a replace stopped before removing anything', () => {
    const result = describeStop({ sent: 0, total: 3, replacing: true, removed: 0, dailyLimit: false })
    expect(result.happened).toBe('Nothing was removed.')
    expect(result.kept).toBeNull() // nothing was held, so there is nothing to say about it
  })
})
