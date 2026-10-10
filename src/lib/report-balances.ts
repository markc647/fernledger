import type { BalanceDifference, BalanceLine, BalancesReport } from '@/generated/api/report-balances'
import { balanceDiffersMessage, differenceDirection, noBalanceReason } from './balance-check'
import { formatBalance, formatDate } from './format'

// The balances-over-time Report's data and words, put together in the browser from the API (worker/report-balances.ts, one
// request for each Account). The numbers come from the API and are never worked out again here; this file only chooses what to say.

export type { BalanceDifference, BalanceLine, BalancesReport }

/** An Account with its Report. */
export type AccountBalances = { accountId: number; accountName: string; accountNumber: string; cutoverDate: string | null; report: BalancesReport }

export type BalancesRequest = { accountId: number; from: string; to: string }

/**
 * Reads the Report of each Account for the dates, one small request each, and keeps the Accounts in the order given. A failed
 * request fails the whole Report: an Account that was not read must never look like one with no balances.
 */
export function loadBalances({
  accounts,
  from,
  to,
  fetchReport,
}: {
  accounts: { id: number; name: string; accountNumber: string; cutoverDate: string | null }[]
  from: string
  to: string
  fetchReport: (request: BalancesRequest) => Promise<BalancesReport>
}): Promise<AccountBalances[]> {
  return Promise.all(
    accounts.map(async ({ id, name, accountNumber, cutoverDate }) => ({
      accountId: id,
      accountName: name,
      accountNumber,
      cutoverDate,
      report: await fetchReport({ accountId: id, from, to }),
    })),
  )
}

/** What an Account's section of the Report has to say, before any figures. */
export type Outlook =
  | { kind: 'balances' }
  /** No bank balance can be counted, so nothing can be worked out; `reason` is the Summary's words for why. */
  | { kind: 'no-balance'; reason: string }
  /** The dates end before the first date held. */
  | { kind: 'before-held'; heldFrom: string }
  /** The dates begin after the last date held. */
  | { kind: 'after-held'; heldTo: string }

export function outlook(report: BalancesReport): Outlook {
  if (report.held === null) return { kind: 'no-balance', reason: noBalanceReason(report.latestStatus) }
  if (report.rows.length > 0) return { kind: 'balances' }
  return report.to < report.held.from ? { kind: 'before-held', heldFrom: report.held.from } : { kind: 'after-held', heldTo: report.held.to }
}

/** What the opening balance is the balance of: the day before the first Transaction held, or the day the dates begin. */
export function openingLabel(report: BalancesReport) {
  return report.opening?.beforeFirst ? `Before the first Transaction held, ${formatDate(report.held!.from)}` : `At the start of ${formatDate(report.from)}`
}

export const closingLabel = (report: BalancesReport) => `At the end of ${formatDate(report.closing!.date)}`

/** Where the Transactions held stop short of the dates asked for, so a reader doesn't take the missing months for months with no money in them. */
export function heldNotes(report: BalancesReport, cutoverDate: string | null): string[] {
  const { held } = report
  if (held === null) return []
  const notes: string[] = []
  if (report.from < held.from) notes.push(`No Transactions are held before ${formatDate(held.from)}.`)
  if (report.to > held.to) {
    notes.push(`No Transactions are held after ${formatDate(held.to)}, so the Report stops there.`)
    // The words the Summary uses for an Account that waits on the bank link (src/components/summary/balances-widget.tsx).
    if (cutoverDate !== null && held.to < cutoverDate && cutoverDate <= report.to)
      notes.push(`From its Cutover Date, ${formatDate(cutoverDate)}, this Account's Transactions will come from the bank link once syncing starts.`)
  }
  return notes
}

/** Where a line's balance comes from: worked out from the Transactions, or also given by the bank that day. The calculated figure is never replaced. */
export function sourceOf(line: BalanceLine) {
  if (line.bankCents === null) return 'Calculated from the Transactions'
  if (line.bankCents === line.balanceCents) return 'Bank balance'
  return `Calculated from the Transactions. The bank gave ${formatBalance(line.bankCents)}.`
}

/** A Balance Check difference in the Balance Check's own words (src/lib/balance-check.ts), and the bank balance that found it. */
export function describeDifference(difference: BalanceDifference) {
  return {
    headline: balanceDiffersMessage(difference.differenceCents, difference.since),
    found: `Found in the bank balance of ${formatDate(difference.asOfDate)}.`,
    direction: differenceDirection(difference.differenceCents),
  }
}

/** The sentence for when there are no differences to list: it says the bank agrees only if a Balance Check was made. Null when there are differences. */
export function differencesSummary(report: BalancesReport) {
  if (report.differences.length > 0) return null
  return report.checked > 0 ? 'No difference was found. Every Balance Check that covers these dates agrees with the bank.' : 'No Balance Check covers these dates, so none could find a difference.'
}
