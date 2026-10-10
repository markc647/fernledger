import { formatBalance, formatMonth } from './format'

// How the Budgets page and the Summary's Budget vs actual read a Budget. Money on the wire is integer cents; months are NZ calendar
// months, `YYYY-MM` (the Worker's budget-rules.ts and months.ts). Which Budget a month has is decided by the Worker, never here.

export type BudgetStatus = {
  kind: 'under' | 'on' | 'over'
  /** The `Status` tone (src/components/status.tsx): an icon as well as words, never colour alone. */
  tone: 'success' | 'neutral' | 'danger'
  words: string
  /** What is left, or by how much it is over, as a short phrase. */
  detail: string
}

/**
 * Where a Category stands against its Budget for the month. Exactly the Budget spent is "On Budget": nothing left, but not over.
 * `spentCents` is money out less money in (worker/spending.ts), so it can be below zero, which leaves more than the whole Budget.
 */
export function budgetStatus(budgetCents: number, spentCents: number): BudgetStatus {
  if (spentCents > budgetCents) return { kind: 'over', tone: 'danger', words: 'Over Budget', detail: `${formatBalance(spentCents - budgetCents)} over` }
  if (spentCents === budgetCents) return { kind: 'on', tone: 'neutral', words: 'On Budget', detail: 'Nothing left' }
  return { kind: 'under', tone: 'success', words: 'Under Budget', detail: `${formatBalance(budgetCents - spentCents)} left` }
}

/** What a Category spent, in words: "$55.50", or "$15.00 back" when more came back than went out (a refund), never a minus sign for spending. */
export const spentText = (spentCents: number) => (spentCents < 0 ? `${formatBalance(-spentCents)} back` : formatBalance(spentCents))

/** The changes to a Category's Budget that begin after `month`: a Budget set from `month` stops when the first of them starts. */
export const laterChanges = <T extends { effectiveFrom: string }>(changes: T[], month: string) => changes.filter((change) => change.effectiveFrom > month)

const COUNTING = ', counting changes kept for Categories that are no longer Spending or have been removed'

/** A reminder that Budget changes are limited and permanent, once the history is nearly full; null while there is plenty of room. */
export function capNotice(count: number, limit: number): string | null {
  if (count < limit * 0.9) return null
  return count >= limit
    ? `Fernledger keeps at most ${limit} Budget changes, for good, and all ${limit} are used${COUNTING}. A month that already has a change can still be replaced.`
    : `Fernledger keeps at most ${limit} Budget changes, for good, and none can be removed. ${count} are used${COUNTING}.`
}

/** The month `by` months from `month` (before it when `by` is negative), both `YYYY-MM`. */
export function addMonths(month: string, by: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + by
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** A year back to two years ahead of this month: the months the Admin can start a Budget from. The Worker takes any month from 2000 to 2100. */
export function monthChoices(thisMonth: string): { value: string; label: string }[] {
  return Array.from({ length: 37 }, (_, i) => {
    const value = addMonths(thisMonth, i - 12)
    return { value, label: formatMonth(value) }
  })
}

/** One of a Category's changes, in words: "From August 2026: $800.00 a month". */
export const changeLine = (change: { effectiveFrom: string; amountCents: number | null }) =>
  `From ${formatMonth(change.effectiveFrom)}: ${change.amountCents === null ? 'no Budget' : `${formatBalance(change.amountCents)} a month`}`

/** What the Admin is told after saving, from what the Worker answered. */
export function savedMessage(categoryName: string, result: { effectiveFrom: string; amountCents: number | null; changed: boolean }): string {
  const month = formatMonth(result.effectiveFrom)
  if (result.amountCents === null) return result.changed ? `Ended the Budget for ${categoryName} from ${month}.` : `${categoryName} has no Budget in ${month}, so there is nothing to end.`
  const amount = `${formatBalance(result.amountCents)} a month`
  return result.changed ? `${categoryName} now has a Budget of ${amount} from ${month}.` : `${categoryName} already has a Budget of ${amount} in ${month}, so nothing changed.`
}
