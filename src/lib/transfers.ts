// How the pages put a Transfer into words (GLOSSARY.md: Transfer). The Worker decides whether a Transaction is one and how
// (worker/effective-category.ts); this is only the wording, so the list and the details can't say different things.

/** What the API says about a Transaction's Transfer. `transferAccountName` is the Account of the Transaction it is paired with, even when an Override makes this one spending. */
export type TransferFields = { amountCents: number; transfer: 'pair' | 'rule' | null; transferAccountName: string | null }

/** The Transaction's name as a Transfer: "Transfer to Savings" for money out, "Transfer from Savings" for money in, "Transfer" when only a Rule marks it. Null for spending. */
export function transferLabel(t: TransferFields): string | null {
  if (t.transfer === null) return null
  if (t.transfer === 'rule' || t.transferAccountName === null) return 'Transfer'
  return `Transfer ${t.amountCents < 0 ? 'to' : 'from'} ${t.transferAccountName}`
}

/** What a Transaction's details say about its Transfer, or null when there is nothing to say. */
export function transferExplanation(t: TransferFields): string | null {
  if (t.transfer === 'pair') {
    const moved = t.transferAccountName === null ? 'Money moved between Accounts.' : `Money moved ${t.amountCents < 0 ? 'to' : 'from'} ${t.transferAccountName}.`
    return `${moved} It is not counted as spending.`
  }
  if (t.transfer === 'rule') return 'A Rule marks this as a Transfer, so it is not counted as spending. No matching Transaction was found in another Account.'
  // An Override outranks the pairing for the Transaction it is on, which is why this one is spending although it has a pair.
  if (t.transferAccountName !== null) return `This matches a Transaction in ${t.transferAccountName}, but it is counted as spending because the Admin chose a Category for it.`
  return null
}
