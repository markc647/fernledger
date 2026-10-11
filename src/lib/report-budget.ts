// A relative path, not `@/`: the Worker's test pins MAX_REPORT_MONTHS to the Worker's by importing this file, and the Worker's compiler has no `@` alias.
import type { BudgetReport, CategoryPeriod, ReportMonth } from '../generated/api/report-budget'
import { budgetStatus, SPENDING_OUTSIDE_BUDGETS, UNCATEGORISED_SPENDING, type BudgetRow } from './budgets'
import { describeRange } from './report-frame'
import { parseReportSearch, type ReportSearch } from './report-transactions'

// The Budget vs actual Report's data and words, put together in the browser from the API (worker/report-budget.ts, one request for all the months).
// Every amount comes from the API and none is added up here; this file only chooses what to say, and counts the months that were over Budget with
// `budgetStatus`, the rule the Summary uses, so "over" means the same in both.

export type { BudgetReport, CategoryPeriod, ReportMonth }

/** The most months a Report covers. The Worker keeps its own copy (worker/report-budget.ts); worker/report-budget.test.ts pins the two together. */
export const MAX_REPORT_MONTHS = 24

/**
 * A Budget is for all Accounts together, so a Report of Budgets takes no Account: an `account` in its address is ignored, and the Report is of every Account. The
 * router merges what a route validates over the whole address (a search parameter a route does not validate is still passed on), so `account` is set to
 * undefined here rather than left out.
 */
export function parseBudgetReportSearch(raw: Record<string, unknown>): ReportSearch {
  const { from, to } = parseReportSearch(raw)
  return { account: undefined, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
}

/** How many NZ months the dates touch, both ends included (`2026-01-15` to `2026-03-10` touch 3). The dates are real and `from` is not after `to`. */
export const monthsTouched = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1

/** What to say, instead of opening the Report, when the dates touch more months than a Report covers; null when they don't. */
export const tooManyMonths = (from: string, to: string) =>
  monthsTouched(from, to) > MAX_REPORT_MONTHS ? `A Budget vs actual Report covers at most ${MAX_REPORT_MONTHS} months. Choose dates that touch ${MAX_REPORT_MONTHS} months or fewer.` : null

/** Whether a month is over, is the month it is now, or is still to come, by the Worker's own idea of this NZ month (`thisMonth`). */
export type MonthState = 'finished' | 'under-way' | 'not-begun'
export const monthState = (month: string, thisMonth: string): MonthState => (month < thisMonth ? 'finished' : month === thisMonth ? 'under-way' : 'not-begun')

/** What a reader needs to know about a month that is not a finished one; null for a finished month. */
export function monthNote(state: MonthState): string | null {
  if (state === 'under-way') return 'This month is not over yet, so what has been spent so far is compared with the whole month’s Budget.'
  if (state === 'not-begun') return 'This month has not begun, so nothing has been spent yet.'
  return null
}

/** Said under the title block when the dates are not whole months, because a Budget is for a whole month; null when they are. */
export const wholeMonthsNotice = (report: BudgetReport) =>
  report.from === report.covers.from && report.to === report.covers.to
    ? null
    : `You chose ${describeRange(report.from, report.to)}. A Budget is for a whole month, so this Report shows every month those dates touch, in full: ${describeRange(report.covers.from, report.covers.to)}.`

/** How many of the months were over a Category's Budget, by the Summary's own rule (`budgetStatus`). */
export const monthsOver = (months: ReportMonth[], categoryId: number) =>
  months.filter((month) => month.rows.some((row) => row.categoryId === categoryId && budgetStatus(row.budgetCents, row.spentCents).kind === 'over')).length

/** A row of the all-months table: a Budget row, with "2 of 12 months" over Budget for a Category and null for what is not in a Budget. */
export type PeriodRow = BudgetRow & { overMonths: string | null }

/** "1 of 6 months", "0 of 1 month": how many of the months a Category had a Budget it was over. */
export const overMonthsText = (over: number, months: number) => `${over} of ${months} ${months === 1 ? 'month' : 'months'}`

/** The all-months table's rows: each Category that had a Budget in some month, then Spending outside Budgets, then Uncategorised, as a month's rows are. */
export function periodRows(report: BudgetReport): PeriodRow[] {
  return [
    ...report.categories.map((category) => ({
      key: String(category.categoryId),
      name: category.categoryName,
      budgetCents: category.budgetCents,
      spentCents: category.spentCents,
      overMonths: overMonthsText(monthsOver(report.months, category.categoryId), category.months),
    })),
    { key: 'other', name: SPENDING_OUTSIDE_BUDGETS, budgetCents: null, spentCents: report.total.otherCents, overMonths: null },
    { key: 'uncategorised', name: UNCATEGORISED_SPENDING, budgetCents: null, spentCents: report.total.uncategorisedCents, overMonths: null },
  ]
}
