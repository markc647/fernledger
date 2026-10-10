import { describe, expect, it } from 'vitest'
import { transferExplanation, transferLabel } from './transfers'

const paired = { transfer: 'pair' as const, transferAccountName: 'Savings' }

describe('transferLabel', () => {
  it('names the other Account, to for money out and from for money in', () => {
    expect(transferLabel({ ...paired, amountCents: -5000 })).toBe('Transfer to Savings')
    expect(transferLabel({ ...paired, amountCents: 5000 })).toBe('Transfer from Savings')
  })

  it('says only Transfer when a Rule marks it and there is no other Account', () => {
    expect(transferLabel({ transfer: 'rule', transferAccountName: null, amountCents: -50 })).toBe('Transfer')
  })

  it('is nothing for spending, even when an Override makes a paired Transaction spending', () => {
    expect(transferLabel({ transfer: null, transferAccountName: null, amountCents: -5000 })).toBeNull()
    expect(transferLabel({ transfer: null, transferAccountName: 'Savings', amountCents: -5000 })).toBeNull()
  })
})

describe('transferExplanation', () => {
  it('says where the money went or came from, and that it is not spending', () => {
    expect(transferExplanation({ ...paired, amountCents: -5000 })).toBe('Money moved to Savings. It is not counted as spending.')
    expect(transferExplanation({ ...paired, amountCents: 5000 })).toBe('Money moved from Savings. It is not counted as spending.')
  })

  it('says a Rule marked it when nothing paired with it', () => {
    expect(transferExplanation({ transfer: 'rule', transferAccountName: null, amountCents: -50 })).toMatch(/^A Rule marks this as a Transfer/)
  })

  it('explains why a paired Transaction is spending when the Admin chose a Category', () => {
    expect(transferExplanation({ transfer: null, transferAccountName: 'Savings', amountCents: -5000 })).toBe(
      'This matches a Transaction in Savings, but it is counted as spending because the Admin chose a Category for it.',
    )
  })

  it('has nothing to say about spending', () => {
    expect(transferExplanation({ transfer: null, transferAccountName: null, amountCents: -5000 })).toBeNull()
  })
})
