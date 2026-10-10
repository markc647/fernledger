import { describe, expect, it } from 'vitest'
import { notTransferQuestion, notTransferSaved, transferEditHint, transferExplanation, transferLabel, treatAsTransferAgainSaved } from './transfers'

const paired = { transfer: 'pair' as const, transferAccountName: 'Savings', transferPartnerOverridden: false, notTransfer: false, canMarkNotTransfer: true }
const spending = { transfer: null, transferAccountName: null, transferPartnerOverridden: false, notTransfer: false, canMarkNotTransfer: false }

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

  it('says when the matching Transaction counts as spending', () => {
    expect(transferExplanation({ ...paired, amountCents: -5000, transferPartnerOverridden: true })).toBe(
      'Money moved to Savings. It is not counted as spending. The matching Transaction counts as spending, because the Admin chose a Category for it.',
    )
  })

  it('says a Rule marked it when nothing paired with it', () => {
    expect(transferExplanation({ ...spending, transfer: 'rule', amountCents: -50 })).toMatch(/^A Rule marks this as a Transfer/)
  })

  it('explains why a paired Transaction is spending when the Admin chose a Category, and that its matching Transaction stays a Transfer', () => {
    expect(transferExplanation({ ...spending, transferAccountName: 'Savings', amountCents: -5000 })).toBe(
      'This matches a Transaction in Savings, but it counts as spending because the Admin chose a Category for it. The matching Transaction stays a Transfer.',
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

  it('says the Admin marked it Not a Transfer, which is why it is spending and has no matching Transaction', () => {
    expect(transferExplanation({ ...spending, notTransfer: true, amountCents: -5000 })).toBe('The Admin marked this Not a Transfer, so it counts as spending and is not paired with another Transaction.')
  })
})

describe('transferEditHint', () => {
  it('tells the Admin a Category makes a Transfer spending, and to use Not a Transfer if the pairing is wrong', () => {
    expect(transferEditHint({ transfer: 'pair' })).toBe(
      'This Transaction is a Transfer, so choosing a Category also makes it count as spending. Its matching Transaction stays a Transfer. If the pairing is wrong, use Not a Transfer instead.',
    )
  })

  it('does not mention a matching Transaction when only a Rule marks it', () => {
    expect(transferEditHint({ transfer: 'rule' })).toBe(
      'This Transaction is a Transfer, so choosing a Category also makes it count as spending. If it should not be a Transfer, use Not a Transfer instead.',
    )
  })

  it('says nothing for spending', () => {
    expect(transferEditHint({ transfer: null })).toBeNull()
  })
})

describe('notTransferQuestion', () => {
  it('names the matching Transaction by its Account, says both stop being a Transfer and that neither is paired with any other, and that it can be undone', () => {
    expect(notTransferQuestion({ transferAccountName: 'Savings' })).toBe(
      "This Transaction and its matching Transaction in Savings will both stop being a Transfer and count as spending. Fernledger won't pair them, or either one with any other Transaction. You can undo this.",
    )
  })

  it('says only this Transaction changes when a Rule marks it and nothing is paired with it', () => {
    expect(notTransferQuestion({ transferAccountName: null })).toBe(
      "A Rule marks this as a Transfer. It will stop being a Transfer and count as spending, whatever the Rule says, and Fernledger won't pair it with another Transaction. You can undo this.",
    )
  })
})

describe('what the page says after Not a Transfer and after undoing it', () => {
  it('says it is saved', () => {
    expect(notTransferSaved()).toBe('Marked Not a Transfer.')
  })

  it('says when it paired with its matching Transaction again', () => {
    expect(treatAsTransferAgainSaved(true)).toBe('Treated as a Transfer again. It is paired with its matching Transaction.')
  })

  it('says when there was no match to pair with, without saying it is a Transfer again, and when it will be one', () => {
    expect(treatAsTransferAgainSaved(false)).toBe('Took Not a Transfer off. It is a Transfer only if a Rule marks it, or when a matching Transaction is imported.')
  })
})
