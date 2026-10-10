// How the pages put a Transfer into words (GLOSSARY.md: Transfer). The Worker decides whether a Transaction is one and how
// (worker/effective-category.ts); this is only the wording, so the list, the details and the Edit panel can't say different things.
// A Transaction's matching Transaction is the one it is paired with, in the other Account.

import type { TransferSource } from '../generated/api/effective-category'

/** How a Transaction is a Transfer: paired with a matching Transaction, or marked by a Rule when nothing paired with it (the Worker's type: worker/effective-category.ts). */
export type { TransferSource }

/** What the API says about a Transaction's Transfer. `transferAccountName` is the Account of its matching Transaction, even when an Override makes this one spending. */
export type TransferFields = { amountCents: number; transfer: TransferSource | null; transferAccountName: string | null }

/** The details also say whether the matching Transaction has an Override of its own, which makes it spending. */
export type TransferDetailFields = TransferFields & { transferPartnerOverridden: boolean }

/** The Transaction's name as a Transfer: "Transfer to Savings" for money out, "Transfer from Savings" for money in, "Transfer" when only a Rule marks it. Null for spending. */
export function transferLabel(t: TransferFields): string | null {
  if (t.transfer === null) return null
  if (t.transfer === 'rule' || t.transferAccountName === null) return 'Transfer'
  return `Transfer ${t.amountCents < 0 ? 'to' : 'from'} ${t.transferAccountName}`
}

/**
 * What the Edit panel says about choosing a Category for a Transaction that is a Transfer: that it then counts as spending, and that its
 * matching Transaction stays a Transfer, so a wrong pairing needs a Category on each half. Null for spending.
 */
export function transferEditHint(t: Pick<TransferFields, 'transfer'>): string | null {
  if (t.transfer === null) return null
  const matching = t.transfer === 'pair' ? ' Its matching Transaction stays a Transfer unless it has a Category of its own; set a Category on it too if the pairing is wrong.' : ''
  return `This Transaction is a Transfer, so choosing a Category also makes it count as spending.${matching}`
}

/** What a Transaction's details say about its Transfer, or null when there is nothing to say. */
export function transferExplanation(t: TransferDetailFields): string | null {
  const where = t.transferAccountName
  if (t.transfer === 'pair') {
    const moved = where === null ? 'Money moved between Accounts.' : `Money moved ${t.amountCents < 0 ? 'to' : 'from'} ${where}.`
    const counted = t.transferPartnerOverridden ? ` The matching Transaction counts as spending, because the Admin chose a Category for it. Set a Category on this one too if the pairing is wrong.` : ''
    return `${moved} It is not counted as spending.${counted}`
  }
  if (t.transfer === 'rule') return 'A Rule marks this as a Transfer, so it is not counted as spending. No matching Transaction was found in another Account.'
  if (where === null) return null
  // An Override outranks the pairing for the Transaction it is on, which is why this one is spending although it has a matching Transaction.
  if (t.transferPartnerOverridden) return `This matches a Transaction in ${where}. Both count as spending, because the Admin chose a Category for each.`
  return `This matches a Transaction in ${where}, but it counts as spending because the Admin chose a Category for it. The matching Transaction stays a Transfer; set a Category on it too if the pairing is wrong.`
}
