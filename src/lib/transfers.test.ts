import { describe, expect, it } from 'vitest'
import { transferEditHint, transferExplanation, transferLabel } from './transfers'

const paired = { transfer: 'pair' as const, transferAccountName: 'Savings', transferPartnerOverridden: false }
// Not a Transfer: spending, income or a loan, whichever its Category's kind makes it.
const notATransfer = { transfer: null, transferAccountName: null, transferPartnerOverridden: false }

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

  it("says the matching Transaction counts under its own Category's kind, not as spending, and what to do if the pairing is wrong", () => {
    const text = transferExplanation({ ...paired, amountCents: -5000, transferPartnerOverridden: true })

    expect(text).toBe(
      "Money moved to Savings. It is not counted as spending. The matching Transaction counts under its own Category's kind, because the Admin chose a Category for it. Set a Category on this one too if the pairing is wrong.",
    )
    expect(text).not.toMatch(/counts as spending/) // the Category may be Income or Loans
  })

  it('says a Rule marked it when nothing paired with it', () => {
    expect(transferExplanation({ ...notATransfer, transfer: 'rule', amountCents: -50 })).toMatch(/^A Rule marks this as a Transfer/)
  })

  it("explains why a paired Transaction is not a Transfer when the Admin chose a Category, that it counts under that Category's kind, and that its matching Transaction stays a Transfer", () => {
    const text = transferExplanation({ ...notATransfer, transferAccountName: 'Savings', amountCents: -5000 })

    expect(text).toBe(
      "This matches a Transaction in Savings, but it counts under its Category's kind, because the Admin chose a Category for it. The matching Transaction stays a Transfer; set a Category on it too if the pairing is wrong.",
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
})

describe('transferEditHint', () => {
  it("tells the Admin a Category takes a Transfer out of the Transfers and counts it under that Category's kind, and that the matching Transaction needs one too if the pairing is wrong", () => {
    const text = transferEditHint({ transfer: 'pair' })

    expect(text).toBe(
      "This Transaction is a Transfer. Choosing a Category takes it out of the Transfers: it then counts under that Category's kind, which is Spending, Income or Loans. Its matching Transaction stays a Transfer unless it has a Category of its own; set a Category on it too if the pairing is wrong.",
    )
    expect(text).not.toMatch(/count as spending/)
  })

  it('does not mention a matching Transaction when only a Rule marks it', () => {
    expect(transferEditHint({ transfer: 'rule' })).toBe("This Transaction is a Transfer. Choosing a Category takes it out of the Transfers: it then counts under that Category's kind, which is Spending, Income or Loans.")
  })

  it('says nothing when it is not a Transfer', () => {
    expect(transferEditHint({ transfer: null })).toBeNull()
  })
})
