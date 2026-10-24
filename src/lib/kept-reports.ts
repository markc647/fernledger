import type { KeptReport } from '@/generated/api/kept-reports'
import { reportHref } from './report-address'
import { describeRange } from './report-frame'
import { REPORTS, type ReportInfo } from './reports'

// Kept Reports: each time the Admin shows a Report, its CHOICES are kept (worker/kept-reports.ts), and the Reports page lists them for every Member to open. A kept Report is not a
// snapshot: opening it reads today's data again. These are the words the list uses for a kept Report's choices, the address it opens at, and what the Report page sends to keep one.

export type { KeptReport }

/** The Report a kept Report is of, by its address (`/reports/spending`): undefined for one this version of the app does not know. */
export const reportOf = (kept: Pick<KeptReport, 'report'>): ReportInfo | undefined => Object.values(REPORTS).find((report) => report.to === `/reports/${kept.report}`)

/** The last part of a Report's address, which is how the Worker names it. */
export const slugOf = (report: ReportInfo) => report.to.slice('/reports/'.length) as KeptReport['report']

/** What a Report's page chose: the Account or Loans Category (left out for all of them) and the dates (a Loans Report may have no start). */
export type Chosen = { account?: number; category?: number; from?: string; to: string }

/**
 * What the Report page sends to keep the Report it is showing, in the Worker's words (`keepBody`): only the choices that Report has, so a Budget vs actual address that still carries an
 * old `account` keeps no Account.
 */
export function keepRequest(report: ReportInfo, chosen: Chosen) {
  const reads = (name: string) => (report.choices as readonly string[]).includes(name)
  return {
    report: slugOf(report),
    ...(reads('account') && chosen.account !== undefined ? { accountId: chosen.account } : {}),
    ...(reads('category') && chosen.category !== undefined ? { categoryId: chosen.category } : {}),
    ...(chosen.from !== undefined ? { from: chosen.from } : {}),
    to: chosen.to,
  }
}

/** The address a kept Report opens at: its Report's page, with its choices in the order its form has them. */
export function keptHref(kept: KeptReport): string | null {
  const report = reportOf(kept)
  if (!report) return null
  const fields: [string, string][] = []
  if (kept.accountId !== null) fields.push(['account', String(kept.accountId)])
  if (kept.categoryId !== null) fields.push(['category', String(kept.categoryId)])
  if (kept.from !== null) fields.push(['from', kept.from])
  fields.push(['to', kept.to])
  return reportHref(report.to, fields)
}

/** The Report's name as the list says it. */
export const keptName = (kept: KeptReport) => reportOf(kept)?.name ?? 'A Report this version does not know'

/** The dates, the way a Report's own title block says them. */
export const keptDates = (kept: KeptReport) => describeRange(kept.from, kept.to)

/** The Account, or "All Accounts": a Report that has none (Loans, Budget vs actual) is of all of them together. */
export const keptAccount = (kept: KeptReport) => (kept.accountId === null ? 'All Accounts' : (kept.accountName ?? 'An Account that is no longer here'))

/** The Loans Category a kept Loans Report is of, or all of them; null for any other Report. */
export function keptLoan(kept: KeptReport): string | null {
  if (reportOf(kept) !== REPORTS.loans) return null
  if (kept.categoryId === null) return 'All loans'
  return kept.categoryRemoved ? `${kept.categoryName ?? 'A Category'} (removed)` : (kept.categoryName ?? 'A Category that is no longer here')
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The kept Report as a sentence says it, after "Delete the": "Spending by Category Report for Loan – Alice, from the first Transaction to Sat 31 Oct 2026, all Accounts". What the list
 * writes as a phrase of its own ("All Accounts", "From the first Transaction") loses its capital in the middle of a sentence; a name (an Account, a Category) and a date keep theirs.
 */
export function keptInSentence(kept: KeptReport): string {
  const loan = keptLoan(kept)
  const account = keptAccount(kept)
  return [
    reportOf(kept) ? `${keptName(kept)} Report${loan === null ? '' : ` for ${kept.categoryName === null ? lower(loan) : loan}`}` : 'Report that this version does not know',
    kept.from === null ? lower(keptDates(kept)) : keptDates(kept),
    kept.accountName === null ? lower(account) : account,
  ].join(', ')
}

/** The kept Report in a few words, for the name of its row's actions and of its questions: "Loans, Loan – Alice, from the first Transaction to Sat 31 Oct 2026, All Accounts". */
export const keptRowName = (kept: KeptReport) => [keptName(kept), keptLoan(kept), keptDates(kept), keptAccount(kept)].filter((part) => part !== null).join(', ')
