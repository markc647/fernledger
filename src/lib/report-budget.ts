// A relative path, not `@/`: the Worker's test pins MAX_REPORT_MONTHS to the Worker's by importing this file, and the Worker's compiler has no `@` alias.
import type { MonthState } from '../generated/api/months'
import type { BudgetReport, CategoryPeriod, MonthRow, ReportMonth } from '../generated/api/report-budget'
import { SPENDING_OUTSIDE_BUDGETS, UNCATEGORISED_SPENDING, type BudgetRow } from './budgets'
import { formatMonth } from './format'
import { describeRange } from './report-frame'
import { parseReportSearch, type ReportSearch } from './report-transactions'

// The Budget vs actual Report's data and words, put together in the browser from the API (worker/report-budget.ts, one request for all the months).
// Every amount, and every count of months, comes from the API and none is added up here; this file only chooses what to say.

export type { BudgetReport, CategoryPeriod, MonthRow, MonthState, ReportMonth }

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

/** How many NZ months the dates touch, both ends included (`2026-01-15` to `2026-03-10` touch 3). The dates are real and `from` is not after `to`. The Worker's `monthCount` (worker/months.ts) counts the same, and worker/report-budget.test.ts holds the two together. */
export const monthsTouched = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1

/** What to say, instead of opening the Report, when the dates touch more months than a Report covers; null when they don't. */
export const tooManyMonths = (from: string, to: string) =>
  monthsTouched(from, to) > MAX_REPORT_MONTHS ? `A Budget vs actual Report covers at most ${MAX_REPORT_MONTHS} months. Choose dates that touch ${MAX_REPORT_MONTHS} months or fewer.` : null

/** What a reader needs to know about a month that has not ended (the Worker says which); null for one that has. */
export function monthNote(state: MonthState): string | null {
  if (state === 'under-way') return 'This month is not over yet, so what has been spent so far is compared with the whole month’s Budget. It is not in the months together.'
  if (state === 'not-begun') return 'This month has not begun, so nothing has been spent yet. It is not in the months together.'
  return null
}

/** Said under the title block when the dates asked for were part of a month, because a Budget is for a whole month; null when they were whole months. */
export const wholeMonthsNotice = (report: BudgetReport) =>
  report.from === report.covers.from && report.to === report.covers.to
    ? null
    : `You chose ${describeRange(report.from, report.to)}. A Budget is for a whole month, so this Report shows every month those dates touch, in full: ${describeRange(report.covers.from, report.covers.to)}.`

/** True while no month in the Report has a Budget for any Category, which the Report says once at the top rather than for each month. */
export const hasNoBudgets = (report: BudgetReport) => report.months.every((month) => month.rows.length === 0)

const monthsText = (first: string, last: string) => (first === last ? formatMonth(first) : `${formatMonth(first)} to ${formatMonth(last)}`)

/**
 * Which months the months together cover, and why it is not all of them: the months that have ended. The month it is now has had part of its spending set against
 * the whole of its Budget, and a month to come has had none, so counting either would make the Categories look further under Budget than they are.
 */
export function togetherCovers(report: BudgetReport): string {
  const { together, months } = report
  if (together === null) return 'No month in these dates has ended, so there is nothing to add together yet.'
  const covers =
    together.months === 1 ? `These figures are for ${formatMonth(together.first)}, the one month that has ended.` : `These figures cover ${monthsText(together.first, together.last)}, the ${together.months} months that have ended.`
  const leftOut = months.length - together.months
  if (leftOut === 0) return covers
  const underWay = months.find((m) => m.state === 'under-way')
  const notBegun = months.filter((m) => m.state === 'not-begun')
  const why = [
    underWay && `${formatMonth(underWay.month)} is not over yet, so part of its spending would be set against the whole of its Budget.`,
    notBegun.length > 0 &&
      `${monthsText(notBegun[0]!.month, notBegun.at(-1)!.month)} ${notBegun.length === 1 ? 'has' : 'have'} not begun, so ${notBegun.length === 1 ? 'its' : 'their'} Budget would be set against no spending at all.`,
  ]
  return [covers, ...why.filter(Boolean), `${leftOut === 1 ? 'It is' : 'They are'} left out of these figures, and shown on ${leftOut === 1 ? 'its' : 'their'} own below.`].join(' ')
}

/** "1 of 6 months", "0 of 1 month": how many of the months a Category had a Budget it was over. */
export const overMonthsText = (over: number, months: number) => `${over} of ${months} ${months === 1 ? 'month' : 'months'}`

/** A row of the all-months table: a Budget row, with "2 of 12 months" over Budget for a Category and null for what is not in a Budget. */
export type PeriodRow = BudgetRow & { overMonths: string | null }

/** The all-months table's rows: each Category that had a Budget in some ended month, then Spending outside Budgets, then Uncategorised, as a month's rows are. */
export function periodRows(report: BudgetReport): PeriodRow[] {
  return [
    ...report.categories.map((category) => ({
      key: String(category.categoryId),
      name: category.categoryName,
      budgetCents: category.budgetCents,
      spentCents: category.spentCents,
      overMonths: overMonthsText(category.overMonths, category.months),
    })),
    { key: 'other', name: SPENDING_OUTSIDE_BUDGETS, budgetCents: null, spentCents: report.total.otherCents, overMonths: null },
    { key: 'uncategorised', name: UNCATEGORISED_SPENDING, budgetCents: null, spentCents: report.total.uncategorisedCents, overMonths: null },
  ]
}
