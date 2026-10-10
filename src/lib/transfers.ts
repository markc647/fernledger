// How the pages put a Transfer into words (GLOSSARY.md: Transfer). The Worker decides whether a Transaction is one and how
// (worker/effective-category.ts); this is only the wording, so the list, the details and the Edit panel can't say different things.
// A Transaction's matching Transaction is the one it is paired with, in the other Account.

import type { TransferSource } from '../generated/api/effective-category'

/** How a Transaction is a Transfer: paired with a matching Transaction, or marked by a Rule when nothing paired with it (the Worker's type: worker/effective-category.ts). */
export type { TransferSource }

/** What the API says about a Transaction's Transfer. `transferAccountName` is the Account of its matching Transaction, even when an Override makes this one spending. */
export type TransferFields = { amountCents: number; transfer: TransferSource | null; transferAccountName: string | null }

/** The details also say whether the matching Transaction has an Override of its own, which makes it spending, and whether the Admin has said Not a Transfer. */
export type TransferDetailFields = TransferFields & { transferPartnerOverridden: boolean; notTransfer: boolean }

/** The Transaction's name as a Transfer: "Transfer to Savings" for money out, "Transfer from Savings" for money in, "Transfer" when only a Rule marks it. Null for spending. */
export function transferLabel(t: TransferFields): string | null {
  if (t.transfer === null) return null
  if (t.transfer === 'rule' || t.transferAccountName === null) return 'Transfer'
  return `Transfer ${t.amountCents < 0 ? 'to' : 'from'} ${t.transferAccountName}`
}

/**
 * What the Edit panel says about choosing a Category for a Transaction that is a Transfer: that it then counts as spending, and that its
 * matching Transaction stays a Transfer, with Not a Transfer as the way to put a wrong pairing right. Null for spending.
 */
export function transferEditHint(t: Pick<TransferFields, 'transfer'>): string | null {
  if (t.transfer === null) return null
  const counts = 'This Transaction is a Transfer, so choosing a Category also makes it count as spending.'
  return t.transfer === 'pair'
    ? `${counts} Its matching Transaction stays a Transfer. If the pairing is wrong, use Not a Transfer instead.`
    : `${counts} If it should not be a Transfer, use Not a Transfer instead.`
}

/** What a Transaction's details say about its Transfer, or null when there is nothing to say. */
export function transferExplanation(t: TransferDetailFields): string | null {
  const where = t.transferAccountName
  if (t.notTransfer) return 'The Admin has said this is not a Transfer, so it is counted as spending and is not paired with another Transaction.'
  if (t.transfer === 'pair') {
    const moved = where === null ? 'Money moved between Accounts.' : `Money moved ${t.amountCents < 0 ? 'to' : 'from'} ${where}.`
    const counted = t.transferPartnerOverridden ? ' The matching Transaction counts as spending, because the Admin chose a Category for it.' : ''
    return `${moved} It is not counted as spending.${counted}`
  }
  if (t.transfer === 'rule') return 'A Rule marks this as a Transfer, so it is not counted as spending. No matching Transaction was found in another Account.'
  if (where === null) return null
  // An Override outranks the pairing for the Transaction it is on, which is why this one is spending although it has a matching Transaction.
  if (t.transferPartnerOverridden) return `This matches a Transaction in ${where}. Both count as spending, because the Admin chose a Category for each.`
  return `This matches a Transaction in ${where}, but it counts as spending because the Admin chose a Category for it. The matching Transaction stays a Transfer.`
}

/**
 * Whether the Admin can say Not a Transfer: when a pairing or a Rule makes the Transaction a Transfer, or an Override has made a paired one spending
 * (its matching Transaction is still a Transfer, and the pairing is wrong all the same). Never for one the Admin has already marked.
 */
export function canMarkNotTransfer(t: Pick<TransferFields, 'transfer' | 'transferAccountName'> & { notTransfer?: boolean }): boolean {
  return !t.notTransfer && (t.transfer !== null || t.transferAccountName !== null)
}

/** The question the Admin is asked before saying Not a Transfer: what changes, naming the matching Transaction by its Account, and that it can be undone. */
export function notTransferQuestion(t: Pick<TransferFields, 'transferAccountName'>): string {
  return t.transferAccountName === null
    ? 'A Rule marks this as a Transfer. It will stop being a Transfer and count as spending, whatever the Rule says. You can undo this.'
    : `This Transaction and its matching Transaction in ${t.transferAccountName} will both stop being a Transfer and count as spending. Fernledger won't pair them again. You can undo this.`
}

/** What the page says once the Admin has said Not a Transfer. */
export const notTransferSaved = () => 'Marked as not a Transfer.'

/** What the page says once the Admin has treated a Transaction as a Transfer again: whether it found its matching Transaction (the API's `paired`). */
export const treatAsTransferAgainSaved = (paired: boolean) =>
  paired
    ? 'Treated as a Transfer again. It is paired with its matching Transaction.'
    : 'Treated as a Transfer again. It is a Transfer only if a Rule marks it, or when a matching Transaction is imported.'
