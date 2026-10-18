import type { MAX_INLINE_APPLY as WORKER_MAX_INLINE_APPLY, RuleFromTransaction } from '@/generated/api/rule-from-transaction'
import { formatCount } from './format'

// The words of Create Rule, in a Transaction's Edit panel: what the Admin is told while they type what the Rule looks for, and what saving said. The Rule is made by
// POST /api/rules/from-transaction (worker/rule-from-transaction.ts).

export type { RuleFromTransaction }

/** The most other Transactions a Rule made from a Transaction gives the Category to in the request (worker/rule-from-transaction.ts). Typed as the Worker's literal, so the build fails if the two drift apart. */
export const MAX_INLINE_APPLY: typeof WORKER_MAX_INLINE_APPLY = 500

/** The Rule's "Money in or out" for a Transaction: the way its money went, and either for $0.00. */
export const directionOf = (amountCents: number): '' | 'in' | 'out' => (amountCents > 0 ? 'in' : amountCents < 0 ? 'out' : '')

const transactions = (count: number) => `${formatCount(count)} ${count === 1 ? 'Transaction' : 'Transactions'}`

/** How many Transactions the text matches, and how many of them have no Category: "14 Transactions match, 9 of them uncategorised." */
export function countSentence({ matches, uncategorised }: { matches: number; uncategorised: number }): string {
  if (matches === 0) return 'No Transactions match.'
  if (matches === 1) return uncategorised === 1 ? '1 Transaction matches, and it is uncategorised.' : '1 Transaction matches, and it has a Category already.'
  const of = uncategorised === 0 ? 'none of them' : uncategorised === matches ? (matches === 2 ? 'both of them' : 'all of them') : `${formatCount(uncategorised)} of them`
  return `${formatCount(matches)} Transactions match, ${of} uncategorised.`
}

const TOO_MANY = `That is more than ${MAX_INLINE_APPLY}, too many to give a Category at once. Save Category and Rule will save the Rule and give only this Transaction the Category; Apply the Rules to all Transactions, on the Rules page, will give the rest theirs.`

/**
 * What to add to the count when more than MAX_INLINE_APPLY other Transactions would be given the Category, so the Admin knows before they save. `uncategorised` counts this
 * Transaction if the text matches it, which the Worker has the last word on; the other Transactions are all the page can tell, and this is a warning and not a promise.
 */
export const tooManyNote = (uncategorised: number, thisIsUncategorised: boolean): string | null => (uncategorised - (thisIsUncategorised ? 1 : 0) > MAX_INLINE_APPLY ? TOO_MANY : null)

const OVERRIDE_BECAUSE: Record<NonNullable<RuleFromTransaction['overrideBecause']>, string> = {
  'no-match': 'This Transaction does not match the text, so its Category is an Override on it instead.',
  'earlier-rule': 'An earlier Rule matches this Transaction, so its Category is an Override on it instead.',
  categorised: 'This Transaction already had a Category, or is a Transfer, so the Category you chose is an Override on it.',
}

/**
 * What saving a Rule made from a Transaction says, under the row: the Rule (`when`, as the Rules page words it), how many Transactions were given the Category and whether this
 * was one of them or got its Category as an Override instead (and why), and what to do about any that were left.
 */
export function savedRuleSentence(made: RuleFromTransaction, { when, categoryName }: { when: string; categoryName: string }): string {
  const byRule = made.thisBy === 'rule'
  const others = made.categorised - (byRule ? 1 : 0)
  const gave = byRule && made.categorised === 1 ? ` and gave this Transaction the Category ${categoryName}` : made.categorised > 0 ? ` and gave ${transactions(made.categorised)} the Category ${categoryName}${byRule ? ', this one included' : ''}` : ''
  const parts = [`Saved Rule ${made.number} (${when})${gave}.`]
  if (made.overrideBecause) parts.push(OVERRIDE_BECAUSE[made.overrideBecause])
  if (made.moreUncategorised !== null) {
    // More than MAX_INLINE_APPLY, so always more than one.
    parts.push(`${formatCount(made.moreUncategorised)} more Uncategorised Transactions match: that is too many to give the Category at once. Choose Apply the Rules to all Transactions, on the Rules page, to give them theirs.`)
  } else if (others === 0) parts.push('No other Uncategorised Transactions match.')
  return parts.join(' ')
}
