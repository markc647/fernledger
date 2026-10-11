import { describe, expect, it } from 'vitest'
import { notTransferQuestion, notTransferSaved, transferEditHint, transferExplanation, transferLabel, treatAsTransferAgainSaved } from './transfers'

const paired = { transfer: 'pair' as const, transferAccountName: 'Savings', transferPartnerOverridden: false, notTransfer: false, canMarkNotTransfer: true }
// Not a Transfer: spending, income or a loan, whichever its Category's kind makes it.
const notATransfer = { transfer: null, transferAccountName: null, transferPartnerOverridden: false, notTransfer: false, canMarkNotTransfer: false }

describe('transferLabel', () => {
  it('names the other Account, to for money out and from for money in', () => {
    expect(transferLabel({ ...paired, amountCents: -5000 })).toBe('Transfer to Savings')
    expect(transferLabel({ ...paired, amountCents: 5000 })).toBe('Transfer from Savings')
  })

  it('says only Transfer when a Rule marks it and there is no other Account', () => {
    expect(transferLabel({ transfer: 'rule', transferAccountName: null, amountCents: -50 })).toBe('Transfer')
  })

  it('is nothing when it is not a Transfer, even when an Override takes a paired Transaction out of the Transfers', () => {
    expect(transferLabel({ ...notATransfer, amountCents: -5000 })).toBeNull()
    expect(transferLabel({ ...notATransfer, transferAccountName: 'Savings', amountCents: -5000 })).toBeNull()
  })
})

describe('transferExplanation', () => {
  it('says where the money went or came from, and that it is not spending', () => {
    expect(transferExplanation({ ...paired, amountCents: -5000 })).toBe('Money moved to Savings. It is not counted as spending.')
    expect(transferExplanation({ ...paired, amountCents: 5000 })).toBe('Money moved from Savings. It is not counted as spending.')
  })

  it("says the matching Transaction counts under its own Category's kind, not as spending", () => {
    const text = transferExplanation({ ...paired, amountCents: -5000, transferPartnerOverridden: true })

    expect(text).toBe(
      "Money moved to Savings. It is not counted as spending. The matching Transaction counts under its own Category's kind, because the Admin chose a Category for it.",
    )
    expect(text).not.toMatch(/counts as spending/) // the Category may be Income or Loans
  })

  it('says a Rule marked it when nothing paired with it', () => {
    expect(transferExplanation({ ...notATransfer, transfer: 'rule', amountCents: -50 })).toMatch(/^A Rule marks this as a Transfer/)
  })

  it("explains why a paired Transaction is not a Transfer when the Admin chose a Category, that it counts under that Category's kind, and that its matching Transaction stays a Transfer", () => {
    const text = transferExplanation({ ...notATransfer, transferAccountName: 'Savings', amountCents: -5000 })

    expect(text).toBe(
      "This matches a Transaction in Savings, but it counts under its Category's kind, because the Admin chose a Category for it. The matching Transaction stays a Transfer.",
    )
    expect(text).not.toMatch(/counts as spending/)
  })

  it("says each counts under its own Category's kind when both have a Category of their own, as a loan to a child's Account would", () => {
    const text = transferExplanation({ ...notATransfer, transferAccountName: 'Savings', transferPartnerOverridden: true, amountCents: -5000 })

    expect(text).toBe("This matches a Transaction in Savings. Each counts under its own Category's kind, because the Admin chose a Category for each.")
    expect(text).not.toMatch(/count as spending/)
  })

  it('has nothing to say about a Transaction that is not a Transfer and has no matching Transaction', () => {
    expect(transferExplanation({ ...notATransfer, amountCents: -5000 })).toBeNull()
  })

  it("says the Admin marked it Not a Transfer, which is why it has no matching Transaction, and that its Category's kind decides how it counts", () => {
    const text = transferExplanation({ ...notATransfer, notTransfer: true, amountCents: -5000 })

    expect(text).toBe("The Admin marked this Not a Transfer, so it is not paired with another Transaction. It counts under its Category's kind, which is Spending when it has no Category.")
    // Its Category may be Income or Loans: ADR 0012.
    expect(text).not.toMatch(/counts as spending/)
  })
})

describe('transferEditHint', () => {
  it("tells the Admin a Category takes a Transfer out of the Transfers and counts it under that Category's kind, and to use Not a Transfer if the pairing is wrong", () => {
    const text = transferEditHint({ transfer: 'pair' })

    expect(text).toBe(
      "This Transaction is a Transfer. Choosing a Category takes it out of the Transfers: it then counts under that Category's kind, which is Spending, Income or Loans. Its matching Transaction stays a Transfer. If the pairing is wrong, use Not a Transfer instead.",
    )
    expect(text).not.toMatch(/count as spending/)
  })

  it('does not mention a matching Transaction when only a Rule marks it', () => {
    expect(transferEditHint({ transfer: 'rule' })).toBe(
      "This Transaction is a Transfer. Choosing a Category takes it out of the Transfers: it then counts under that Category's kind, which is Spending, Income or Loans. If it should not be a Transfer, use Not a Transfer instead.",
    )
  })

  it('says nothing when it is not a Transfer', () => {
    expect(transferEditHint({ transfer: null })).toBeNull()
  })
})

describe('notTransferQuestion', () => {
  it('names the matching Transaction by its Account, says both stop being a Transfer and that neither is paired with any other, and that it can be undone', () => {
    expect(notTransferQuestion({ transferAccountName: 'Savings' })).toBe(
      "This Transaction and its matching Transaction in Savings will both stop being a Transfer and count under their own Category's kind (Spending when they have no Category). Fernledger won't pair them, or either one with any other Transaction. You can undo this.",
    )
  })

  it('says only this Transaction changes when a Rule marks it and nothing is paired with it', () => {
    expect(notTransferQuestion({ transferAccountName: null })).toBe(
      "A Rule marks this as a Transfer. It will stop being a Transfer, whatever the Rule says, and count under its Category's kind (Spending when it has no Category). Fernledger won't pair it with another Transaction. You can undo this.",
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
