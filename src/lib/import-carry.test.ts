import { describe, expect, it } from 'vitest'
import { describeCarryBefore, describeDiffering, describeLost, describeWaiting } from './import-carry'

describe('describeCarryBefore', () => {
  it('says nothing when there is nothing of the Admin’s own to carry', () => {
    expect(describeCarryBefore({ withOwnWork: 0, waiting: 0 })).toEqual([])
  })

  it('says how many carry over and how many won’t, once the Worker has forecast it', () => {
    const [headline] = describeCarryBefore({ withOwnWork: 40, waiting: 0, preview: { waiting: 40, carries: 38, differing: 0 } })
    expect(headline).toBe("40 Transactions have an Override (your own Category) or a Note. 38 of them carry over to this file; 2 won't.")
  })

  it('agrees with one Transaction', () => {
    expect(describeCarryBefore({ withOwnWork: 1, waiting: 0, preview: { waiting: 1, carries: 1, differing: 0 } })[0]).toBe('1 Transaction has an Override (your own Category) or a Note. It carries over to this file.')
    expect(describeCarryBefore({ withOwnWork: 1, waiting: 0, preview: { waiting: 1, carries: 0, differing: 0 } })[0]).toContain("It won't carry over to this file.")
  })

  it('says they carry over, and that the unmatched are counted afterwards, until the forecast is known', () => {
    const [headline] = describeCarryBefore({ withOwnWork: 40, waiting: 0 })
    expect(headline).toContain('40 Transactions have an Override (your own Category) or a Note. They are carried over')
    expect(headline).toContain('Fernledger counts how many have no match once the Import has run')
    expect(headline).not.toContain('will be lost')
  })

  it('counts what a stopped replace is holding with the rest, and says so', () => {
    const paragraphs = describeCarryBefore({ withOwnWork: 2, waiting: 3, preview: { waiting: 5, carries: 4, differing: 0 } })
    expect(paragraphs[0]).toContain('5 Transactions have')
    expect(paragraphs[1]).toBe('3 were left by an earlier replace that did not finish.')
  })

  it('says how many would go to a Transaction with a different amount', () => {
    const paragraphs = describeCarryBefore({ withOwnWork: 40, waiting: 0, preview: { waiting: 40, carries: 38, differing: 2 } })
    expect(paragraphs).toContain('2 of those would go to a Transaction with a different amount.')
  })

  it('explains in plain words that the bank’s own number can be reused when a day is numbered differently', () => {
    const paragraphs = describeCarryBefore({ withOwnWork: 40, waiting: 0, preview: { waiting: 40, carries: 38, differing: 0 } })
    expect(paragraphs.at(-1)).toContain("the bank's own number for each Transaction")
    expect(paragraphs.at(-1)).toContain('can land on a different Transaction')
    expect(paragraphs.join(' ')).not.toContain('unique ID')
  })

  it('gives a forecast of what a stopped replace holds even when the Account has none of its own', () => {
    expect(describeCarryBefore({ withOwnWork: 0, waiting: 0, preview: { waiting: 3, carries: 3, differing: 0 } })[0]).toContain('3 Transactions have')
  })
})

describe('describeLost', () => {
  it('is null when nothing was lost', () => {
    expect(describeLost(0)).toBeNull()
  })

  it('says how many Transactions lost their Override or Note, and every reason they might have', () => {
    expect(describeLost(2)).toBe(
      "2 Transactions lost their Override or Note. The new file has no Transaction with the bank's own number for them, or they are dated on or after the Cutover Date, or a Transaction from Sync now has that number. The Change Log lists them.",
    )
    expect(describeLost(1)).toContain('1 Transaction lost its Override or Note.')
  })
})

describe('describeDiffering', () => {
  it('is null when none went to another amount', () => {
    expect(describeDiffering(0)).toBeNull()
  })

  it('says how many did, and to check them', () => {
    expect(describeDiffering(2)).toBe('2 Transactions now have an Override or Note that was on a Transaction with a different amount. The bank may have numbered that day differently, so check them.')
    expect(describeDiffering(1)).toContain('1 Transaction now has an Override or Note')
  })
})

describe('describeWaiting', () => {
  it('is null when nothing waits', () => {
    expect(describeWaiting(0)).toBeNull()
  })

  it('says what is waiting, how an Import and a replace treat it, and that it can be discarded', () => {
    const text = describeWaiting(3)!
    expect(text).toContain('3 Overrides and Notes are waiting from a replace that stopped part way.')
    expect(text).toContain('what has no match is then lost')
    expect(text).toContain('discard them')
    expect(describeWaiting(1)).toContain('1 Override or Note is waiting')
  })

  it('says where to find the discard on the finished screen, which has no Discard button', () => {
    expect(describeWaiting(2, true)).toContain('Choose the file again to see them, or discard them, on the next preview.')
    expect(describeWaiting(1, true)).toContain('Choose the file again to see it, or discard it, on the next preview.')
  })
})
