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

/** How an Account stands with the bank, for the Checked column of Balances: its Balance Checks agree (`ok`), one disagrees (`check`, with every span that does, newest first), or it has not been checked (`none`). */
export type Checked<Difference> = { kind: 'ok' } | { kind: 'check'; differences: Difference[] } | { kind: 'none' }

/**
 * Reads the answer of GET /api/balance-checks once, and says how each Account stands. An Account is `check` while any of its spans differs from the bank (`differences`), however its latest
 * check came out, so a difference is not hidden by a later balance that matches the one before it. Otherwise it is `ok` only when its latest check is `matched`: one balance on its own
 * (`alone`), one the check could not use, no balance at all, and an Account the answer does not list are `none`, so the table never claims more than was compared.
 */
export function checkedBy<Difference extends { accountId: number }>(checks: { differences: Difference[]; accounts: { accountId: number; status: string | null }[] }) {
  const differing = new Map<number, Difference[]>()
  for (const difference of checks.differences) differing.set(difference.accountId, [...(differing.get(difference.accountId) ?? []), difference])
  const latest = new Map(checks.accounts.map((account) => [account.accountId, account.status]))
  return (accountId: number): Checked<Difference> => {
    const found = differing.get(accountId)
    if (found) return { kind: 'check', differences: found }
    return latest.get(accountId) === 'matched' ? { kind: 'ok' } : { kind: 'none' }
  }
}

/** How far the newest difference is, short enough to sit under "Check": "by $5.00", and how many earlier ones disagree too ("by $5.00 (and 1 earlier)"). The differences are newest first. */
export const checkedAmount = (differences: { differenceCents: number }[]) =>
  `by ${formatBalance(Math.abs(differences[0]!.differenceCents))}${differences.length > 1 ? ` (and ${differences.length - 1} earlier)` : ''}`

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
