import type { ImportOutcome } from '@/generated/api/balance-rules'
import { formatBalance, formatDate } from './format'

export type BalanceCheckOutcome = ImportOutcome

/** Why an Account has no balance: a bank balance may exist that the Transactions held don't reach. Written for the Summary and the balances Report. */
export function noBalanceReason(latestStatus: string | null) {
  if (latestStatus === 'after-cutover') return 'The bank balance we have is after the Cutover Date'
  if (latestStatus === 'file-ends-early') return 'The file ended before its bank balance date'
  return 'No bank balance yet'
}

/** What the Admin can do about an Account that has no balance, as a sentence that follows `noBalanceReason`. */
export function noBalanceHint(latestStatus: string | null) {
  if (latestStatus === 'after-cutover') return "The Admin can import a file with a bank balance dated before the Cutover Date, or change the Cutover Date in Settings."
  if (latestStatus === 'file-ends-early') return 'The Admin can import a file that runs to its balance date.'
  return 'The Admin can import a bank file to give it one.'
}

/** "Balance differs from bank by $12.34 since Thu 8 Oct 2026": the size of the difference (no sign) and the date of the previous bank balance it was compared with. */
export const balanceDiffersMessage = (differenceCents: number, since: string) =>
  `Balance differs from bank by ${formatBalance(Math.abs(differenceCents))} since ${formatDate(since)}`

/** Which way a difference goes, in words a reader can act on. The difference is the bank's balance minus the Transactions'. */
export const differenceDirection = (differenceCents: number) =>
  differenceCents > 0
    ? "The bank's balance is higher than the Transactions add up to. Some money in may be missing, or some money out counted twice."
    : "The bank's balance is lower than the Transactions add up to. Some money out may be missing, or some money in counted twice."

/** What to tell the Admin after an Import, as a tone for `Status`, a headline and a sentence of detail. */
export function describeBalanceCheck(outcome: BalanceCheckOutcome): { tone: 'success' | 'warning' | 'neutral'; headline: string; detail?: string } {
  switch (outcome.status) {
    case 'differs':
      return { tone: 'warning', headline: balanceDiffersMessage(outcome.differenceCents!, outcome.since!), detail: differenceDirection(outcome.differenceCents!) }
    case 'matched':
      return { tone: 'success', headline: `Balance matches the bank as of ${formatDate(outcome.asOfDate)}` }
    case 'after-cutover':
      return {
        tone: 'neutral',
        headline: 'Balance not checked',
        detail: "This file's balance is dated on or after the Account's Cutover Date, when its Transactions come from Sync, so it can't be compared with the Transactions imported.",
      }
    case 'file-ends-early':
      return {
        tone: 'neutral',
        headline: 'Balance not checked',
        detail: `The file ends before its balance date, ${formatDate(outcome.asOfDate)}, so Transactions may be missing. Export up to that date to check it.`,
      }
    case 'alone':
      return { tone: 'neutral', headline: 'Balance not checked yet', detail: 'This is the first balance Fernledger holds for this Account. The next Import will be checked against it.' }
  }
}
