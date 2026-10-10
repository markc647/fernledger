import { describe, expect, it } from 'vitest'
import { transferEditHint, transferExplanation, transferLabel } from './transfers'

const paired = { transfer: 'pair' as const, transferAccountName: 'Savings', transferPartnerOverridden: false }
const spending = { transfer: null, transferAccountName: null, transferPartnerOverridden: false }

describe('transferLabel', () => {
  it('names the other Account, to for money out and from for money in', () => {
    expect(transferLabel({ ...paired, amountCents: -5000 })).toBe('Transfer to Savings')
    expect(transferLabel({ ...paired, amountCents: 5000 })).toBe('Transfer from Savings')
  })

  it('says only Transfer when a Rule marks it and there is no other Account', () => {
    expect(transferLabel({ transfer: 'rule', transferAccountName: null, amountCents: -50 })).toBe('Transfer')
  })

  it('is nothing for spending, even when an Override makes a paired Transaction spending', () => {
    expect(transferLabel({ ...spending, amountCents: -5000 })).toBeNull()
    expect(transferLabel({ ...spending, transferAccountName: 'Savings', amountCents: -5000 })).toBeNull()
  })
})

describe('transferExplanation', () => {
  it('says where the money went or came from, and that it is not spending', () => {
    expect(transferExplanation({ ...paired, amountCents: -5000 })).toBe('Money moved to Savings. It is not counted as spending.')
    expect(transferExplanation({ ...paired, amountCents: 5000 })).toBe('Money moved from Savings. It is not counted as spending.')
  })

  it('says when the matching Transaction counts as spending, and what to do if the pairing is wrong', () => {
    expect(transferExplanation({ ...paired, amountCents: -5000, transferPartnerOverridden: true })).toBe(
      'Money moved to Savings. It is not counted as spending. The matching Transaction counts as spending, because the Admin chose a Category for it. Set a Category on this one too if the pairing is wrong.',
    )
  })

  it('says a Rule marked it when nothing paired with it', () => {
    expect(transferExplanation({ ...spending, transfer: 'rule', amountCents: -50 })).toMatch(/^A Rule marks this as a Transfer/)
  })

  it('explains why a paired Transaction is spending when the Admin chose a Category, and that its matching Transaction stays a Transfer', () => {
    expect(transferExplanation({ ...spending, transferAccountName: 'Savings', amountCents: -5000 })).toBe(
      'This matches a Transaction in Savings, but it counts as spending because the Admin chose a Category for it. The matching Transaction stays a Transfer; set a Category on it too if the pairing is wrong.',
    )
  })

  it('says both count as spending when each has a Category of its own', () => {
    expect(transferExplanation({ ...spending, transferAccountName: 'Savings', transferPartnerOverridden: true, amountCents: -5000 })).toBe(
      'This matches a Transaction in Savings. Both count as spending, because the Admin chose a Category for each.',
    )
  })

  it('has nothing to say about spending', () => {
    expect(transferExplanation({ ...spending, amountCents: -5000 })).toBeNull()
  })
})

describe('transferEditHint', () => {
  it('tells the Admin a Category makes a Transfer spending, and that the matching Transaction needs one too if the pairing is wrong', () => {
    expect(transferEditHint({ transfer: 'pair' })).toBe(
      'This Transaction is a Transfer, so choosing a Category also makes it count as spending. Its matching Transaction stays a Transfer; set a Category on it too if the pairing is wrong.',
    )
  })

  it('does not mention a matching Transaction when only a Rule marks it', () => {
    expect(transferEditHint({ transfer: 'rule' })).toBe('This Transaction is a Transfer, so choosing a Category also makes it count as spending.')
  })

  it('says nothing for spending', () => {
    expect(transferEditHint({ transfer: null })).toBeNull()
  })
})
