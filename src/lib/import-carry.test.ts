import { describe, expect, it } from 'vitest'
import { describeCarryBefore, describeLost } from './import-carry'

describe('describeCarryBefore', () => {
  it('says nothing when there is nothing of the Admin’s own to carry', () => {
    expect(describeCarryBefore({ withOwnWork: 0, waiting: 0 })).toEqual([])
  })

  it('says the Categories and Notes are carried over to Transactions with the same unique ID, and that the lost can be counted only afterwards', () => {
    const [text, ...rest] = describeCarryBefore({ withOwnWork: 40, waiting: 0 })
    expect(rest).toEqual([])
    expect(text).toContain('40 Transactions have your own Category or a Note.')
    expect(text).toContain('carried over to the Transactions that come back in this file with the same unique ID from your bank')
    expect(text).toContain('only count how many have no match after the Import')
    expect(text).toContain('the Change Log then say how many were lost')
    expect(text).not.toContain('will be lost')
  })

  it('agrees with one Transaction', () => {
    expect(describeCarryBefore({ withOwnWork: 1, waiting: 0 })[0]).toContain('1 Transaction has your own Category or a Note. This is carried over to the Transaction that comes back')
  })

  it('says how many an earlier replace that did not finish is still holding', () => {
    expect(describeCarryBefore({ withOwnWork: 0, waiting: 3 })).toEqual(['3 Categories and Notes are still waiting from an earlier replace that did not finish. They are carried over the same way.'])
    expect(describeCarryBefore({ withOwnWork: 0, waiting: 1 })).toEqual(['1 Category or Note is still waiting from an earlier replace that did not finish. It is carried over the same way.'])
  })

  it('gives both paragraphs when there are both', () => {
    expect(describeCarryBefore({ withOwnWork: 2, waiting: 1 })).toHaveLength(2)
  })
})

describe('describeLost', () => {
  it('is null when nothing was lost', () => {
    expect(describeLost(0)).toBeNull()
  })

  it('says how many Transactions lost their Category or Note, and why', () => {
    expect(describeLost(2)).toBe(
      '2 Transactions had your own Category or a Note, but no Transaction in this file has their unique ID from your bank (or they are dated on or after the Cutover Date), so they are lost. The Change Log records the count.',
    )
    expect(describeLost(1)).toContain('1 Transaction had your own Category or a Note, but no Transaction in this file has its unique ID')
  })
})
