import type { BalanceDifference, BalancesReport, MonthBalance } from '@/generated/api/report-balances'
import { balanceDiffersMessage, differenceDirection, noBalanceReason } from './balance-check'
import { formatBalance, formatDate } from './format'

// The balances-over-time Report's data and words, put together in the browser from the API (worker/report-balances.ts, one
// request for each Account). Every number comes from the API and none is worked out again here, not even the change between the
// opening and the closing balance; this file only chooses what to say.

export type { BalanceDifference, BalancesReport, MonthBalance }

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
  /** No bank balance can be counted, so nothing can be worked out; `reason` is the Summary's own words for why. */
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

/**
 * What the opening balance is the balance of: the day before the first date held, or the day the dates begin. A date is held when
 * Fernledger has a Transaction or a bank balance for the Account on it, so the first date held is not always a Transaction's.
 */
export function openingLabel(report: BalancesReport) {
  return report.opening?.beforeFirst ? `Before the first date held, ${formatDate(report.held!.from)}` : `At the start of ${formatDate(report.from)}`
}

export const closingLabel = (report: BalancesReport) => `At the end of ${formatDate(report.closing!.date)}`

/** Where the dates held stop short of the dates asked for, so a reader doesn't take the missing months for months with no money in them. */
export function heldNotes(report: BalancesReport, cutoverDate: string | null): string[] {
  const { held } = report
  if (held === null) return []
  const notes: string[] = []
  if (report.from < held.from) notes.push(`The first date held for this Account is ${formatDate(held.from)}, so there are no balances before it.`)
  if (report.to > held.to) {
    notes.push(`The last date held for this Account is ${formatDate(held.to)}, so the Report stops there.`)
    // The Summary makes the same promise for an Account that waits on the bank link (src/components/summary/balances-widget.tsx).
    if (cutoverDate !== null && held.to < cutoverDate && cutoverDate <= report.to)
      notes.push(`From its Cutover Date, ${formatDate(cutoverDate)}, this Account's Transactions will come from the bank link once syncing starts.`)
  }
  return notes
}

/**
 * Where a row's balance comes from: worked out from the Transactions, or also given by the bank that day. The calculated figure is
 * never replaced. When the bank's differs, the row says by how much, so a reader doesn't have to subtract.
 */
export function sourceOf(row: MonthBalance) {
  if (row.bankCents === null) return 'Calculated from the Transactions'
  if (row.bankCents === row.balanceCents) return 'Bank balance'
  const gap = row.balanceCents - row.bankCents
  return `Calculated from the Transactions, ${formatBalance(Math.abs(gap))} ${gap < 0 ? 'less' : 'more'} than the bank's ${formatBalance(row.bankCents)}.`
}

/** A Balance Check difference in the Balance Check's own words (src/lib/balance-check.ts, which the Summary shows too), and the bank balance that found it. */
export function describeDifference(difference: BalanceDifference) {
  return {
    headline: balanceDiffersMessage(difference.differenceCents, difference.since),
    found: `Found in the bank balance of ${formatDate(difference.asOfDate)}.`,
    direction: differenceDirection(difference.differenceCents),
  }
}

/**
 * What the differences mean for the balances above them, which a reader would otherwise have to work out. Every balance is worked back
 * from the latest bank balance, so the ones before a difference's date carry it. Null when there are no differences.
 */
export function differencesNote(report: BalancesReport) {
  if (report.differences.length === 0) return null
  return report.differences.length === 1
    ? `Balances before ${formatDate(report.differences[0]!.asOfDate)} are worked back from the latest bank balance, so they carry this difference.`
    : 'Balances before each of these dates are worked back from the latest bank balance, so they carry the difference found there.'
}

/**
 * The sentence for when there are no differences to list. It never says more than was compared: a Balance Check that covers part of the
 * dates covers all of its own, so it says how many there are and the dates they span, which can be more than the Report's. Null when there are differences.
 */
export function differencesSummary(report: BalancesReport) {
  if (report.differences.length > 0) return null
  const { count, coversFrom, coversTo } = report.checks
  if (count === 0 || coversFrom === null || coversTo === null) return 'No Balance Check covers these dates, so none could find a difference.'
  const span = `${formatDate(coversFrom)} to ${formatDate(coversTo)}`
  return count === 1
    ? `No difference was found. The one Balance Check that covers part or all of these dates agrees with the bank. It checks ${span}.`
    : `No difference was found. The ${count} Balance Checks that cover part or all of these dates agree with the bank. Together they check ${span}.`
}
