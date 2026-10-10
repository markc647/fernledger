// How the pages put a Transfer into words (GLOSSARY.md: Transfer). The Worker decides whether a Transaction is one and how
// (worker/effective-category.ts); this is only the wording, so the list, the details and the Edit panel can't say different things.
// A Transaction's matching Transaction is the one it is paired with, in the other Account.

import type { TransferSource } from '../generated/api/effective-category'

/** How a Transaction is a Transfer: paired with a matching Transaction, or marked by a Rule when nothing paired with it (the Worker's type: worker/effective-category.ts). */
export type { TransferSource }

/** What the API says about a Transaction's Transfer. `transferAccountName` is the Account of its matching Transaction, even when an Override takes this one out of the Transfers. */
export type TransferFields = { amountCents: number; transfer: TransferSource | null; transferAccountName: string | null }

/**
 * The details also say whether the matching Transaction has an Override of its own, which takes it out of the Transfers, and whether the Admin has said Not a Transfer.
 * `canMarkNotTransfer` is the Worker's answer to whether they can (effective-category.ts `markable`): the pages never work it out from a pairing or a Rule.
 */
export type TransferDetailFields = TransferFields & { transferPartnerOverridden: boolean; notTransfer: boolean; canMarkNotTransfer: boolean }

/** The Transaction's name as a Transfer: "Transfer to Savings" for money out, "Transfer from Savings" for money in, "Transfer" when only a Rule marks it. Null when it is not a Transfer. */
export function transferLabel(t: TransferFields): string | null {
  if (t.transfer === null) return null
  if (t.transfer === 'rule' || t.transferAccountName === null) return 'Transfer'
  return `Transfer ${t.amountCents < 0 ? 'to' : 'from'} ${t.transferAccountName}`
}

/**
 * What the Edit panel says about choosing a Category for a Transaction that is a Transfer: that it then counts under that Category's kind
 * (ADR 0012), which is Spending, Income or Loans and not always spending, and that its matching Transaction stays a Transfer, with Not a Transfer
 * as the way to put a wrong pairing right. Null when it is not a Transfer.
 */
export function transferEditHint(t: Pick<TransferFields, 'transfer'>): string | null {
  if (t.transfer === null) return null
  const counts = "This Transaction is a Transfer. Choosing a Category takes it out of the Transfers: it then counts under that Category's kind, which is Spending, Income or Loans."
  return t.transfer === 'pair'
    ? `${counts} Its matching Transaction stays a Transfer. If the pairing is wrong, use Not a Transfer instead.`
    : `${counts} If it should not be a Transfer, use Not a Transfer instead.`
}

/** What a Transaction's details say about its Transfer, or null when there is nothing to say. */
export function transferExplanation(t: TransferDetailFields): string | null {
  const where = t.transferAccountName
  if (t.notTransfer) return NOT_TRANSFER_NOTE
  if (t.transfer === 'pair') {
    const moved = where === null ? 'Money moved between Accounts.' : `Money moved ${t.amountCents < 0 ? 'to' : 'from'} ${where}.`
    const counted = t.transferPartnerOverridden ? " The matching Transaction counts under its own Category's kind, because the Admin chose a Category for it." : ''
    return `${moved} It is not counted as spending.${counted}`
  }
  if (t.transfer === 'rule') return 'A Rule marks this as a Transfer, so it is not counted as spending. No matching Transaction was found in another Account.'
  if (where === null) return null
  // An Override outranks the pairing for the Transaction it is on, which is why this one is not a Transfer although it has a matching Transaction.
  if (t.transferPartnerOverridden) return `This matches a Transaction in ${where}. Each counts under its own Category's kind, because the Admin chose a Category for each.`
  return `This matches a Transaction in ${where}, but it counts under its Category's kind, because the Admin chose a Category for it. The matching Transaction stays a Transfer.`
}

/** What the page says of a Transaction the Admin has marked Not a Transfer: it is not paired, and counts under its Category's kind (ADR 0012), Spending when it has none. */
export const NOT_TRANSFER_NOTE = "The Admin marked this Not a Transfer, so it is not paired with another Transaction. It counts under its Category's kind, which is Spending when it has no Category."

/** The question the Admin is asked before saying Not a Transfer: what changes, naming the matching Transaction by its Account, that it is per Transaction, and that it can be undone. */
export function notTransferQuestion(t: Pick<TransferFields, 'transferAccountName'>): string {
  return t.transferAccountName === null
    ? "A Rule marks this as a Transfer. It will stop being a Transfer, whatever the Rule says, and count under its Category's kind (Spending when it has no Category). Fernledger won't pair it with another Transaction. You can undo this."
    : `This Transaction and its matching Transaction in ${t.transferAccountName} will both stop being a Transfer and count under their own Category's kind (Spending when they have no Category). Fernledger won't pair them, or either one with any other Transaction. You can undo this.`
}

/** What the page says once the Admin has said Not a Transfer. */
export const notTransferSaved = () => 'Marked Not a Transfer.'

/** What the page says once the Admin has taken Not a Transfer off: whether the Transaction found a matching Transaction to be paired with (the API's `paired`). */
export const treatAsTransferAgainSaved = (paired: boolean) =>
  paired
    ? 'Treated as a Transfer again. It is paired with its matching Transaction.'
    : 'Took Not a Transfer off. It is a Transfer only if a Rule marks it, or when a matching Transaction is imported.'
