import * as z from 'zod/mini'
import { ALL_CHANGES, budgetInMonth, budgetVsActual, IN_EFFECT, withChanges, type Change, type InEffect, type VsActual } from './budget-rules'
import { monthCount, monthEnd, monthStart, nextMonth, nzMonth } from './months'
import { datesInOrder, reportRange } from './report-query'
import { buildSpending, rollUp, type SpendingRow } from './spending'

// The data of the Budget vs actual Report (GET /api/reports/budget-vs-actual): each NZ month the dates touch, whole, with the Budget each Spending
// Category had in it and what it spent. Nothing is worked out here that Budgets and Spending have not already decided:
// - the Budget in a month is budget-rules.ts's `budgetInMonth` (the latest change on or before the month, nothing carried over), applied to each
//   month, and a month is compared with its spending by the Summary's own `budgetVsActual`, so a month of the Report is a month of the widget;
// - Spending is spending.ts's `buildSpending` and `rollUp` (ADR 0012), read once for all the months, so a Transfer, a Pending Transaction, Income
//   and Loans are left out as they are everywhere else, and the Report's total is `rollUp`'s, not a sum of its months.
// A Budget is for all Accounts together, so the Report is too: it takes no Account.
//
// Cost (ADR 0004): one D1 batch of three statements whatever the dates (the Spending Categories with every Budget change, which is at most
// MAX_BUDGET_CHANGES rows, and the spending), and the spending reads each Transaction in the months three times, four with a Rule's Category.
// The months are capped so the response and the loop over them stay small. worker/report-budget.test.ts pins the statements and the rows read.

/** The most months a Report covers. The Report page keeps its own copy (src/lib/report-budget.ts); worker/report-budget.test.ts pins the two together. */
export const MAX_REPORT_MONTHS = 24

/** The Report's query string: the dates every Report takes, both ends included, with no Account. A refusal names the field (`to` for dates out of order or too many months). */
export const budgetReportQuery = z
  .object({ from: reportRange.from, to: reportRange.to })
  .check(
    datesInOrder,
    z.refine<{ from: string; to: string }>((q) => monthCount(q.from.slice(0, 7), q.to.slice(0, 7)) <= MAX_REPORT_MONTHS, { path: ['to'] }),
  )

export type BudgetReportRequest = { from: string; to: string }

/** One month of the Report. */
export type ReportMonth = {
  /** `YYYY-MM`. */
  month: string
  /** Each Spending Category that has a Budget in the month, with what it spent: the Summary's rows for the month. */
  rows: VsActual[]
  /** What the Spending Categories with no Budget in the month spent. */
  otherCents: number
  /** What Uncategorised spent, which counts as Spending and so includes money in that has no Category yet. */
  uncategorisedCents: number
  /** The month's Budgets added up. */
  budgetCents: number
  /** All Spending in the month (`rollUp`'s), which the rows, `otherCents` and `uncategorisedCents` add up to. */
  spentCents: number
}

/** A Category over the Report's months: its Budgets added up over the months it had one, and what it spent in those months. Its spending in a month with no Budget is in `otherCents`. */
export type CategoryPeriod = { categoryId: number; categoryName: string; months: number; budgetCents: number; spentCents: number }

export type BudgetReport = {
  /** The dates asked for. */
  from: string
  to: string
  /** The dates the Report covers: the whole of every month the dates touch. */
  covers: { from: string; to: string }
  /** The NZ month it is now, so the Report can say which month is not over (or has not begun). */
  thisMonth: string
  /** Every month the dates touch, oldest first, including a month with nothing in it. */
  months: ReportMonth[]
  /** All the months together. `spentCents` is `rollUp`'s total over all of them, which the months' totals add up to. */
  total: { budgetCents: number; spentCents: number; otherCents: number; uncategorisedCents: number }
  /** Each Category that had a Budget in some month, over all the months, in the order of the months' rows. */
  categories: CategoryPeriod[]
}

/**
 * The Report from what D1 gave, with no database: the Spending Categories in use (`inEffect`, of which only the Categories are used; the amounts are
 * for one month), every Budget change, and the range's spending rows. Months are `YYYY-MM`, which compare correctly as text.
 */
export function budgetReport(request: BudgetReportRequest, data: { inEffect: InEffect[]; changes: Change[]; spending: SpendingRow[]; thisMonth: string }): BudgetReport {
  const first = request.from.slice(0, 7)
  const last = request.to.slice(0, 7)
  const categories = withChanges(data.inEffect, data.changes)

  const rowsOf = new Map<string, SpendingRow[]>()
  for (const row of data.spending) {
    const sameMonth = rowsOf.get(row.month)
    if (sameMonth) sameMonth.push(row)
    else rowsOf.set(row.month, [row])
  }

  const periods = new Map<number, CategoryPeriod>(categories.map((c) => [c.categoryId, { categoryId: c.categoryId, categoryName: c.categoryName, months: 0, budgetCents: 0, spentCents: 0 }]))
  const months: ReportMonth[] = []
  for (let month = first; month <= last; month = nextMonth(month)) {
    const spending = rowsOf.get(month) ?? []
    const inMonth = categories.map((c): InEffect => ({ categoryId: c.categoryId, categoryName: c.categoryName, ...budgetInMonth(c.changes, month) }))
    const { rows, otherCents, uncategorisedCents } = budgetVsActual(inMonth, spending)
    for (const row of rows) {
      const period = periods.get(row.categoryId)!
      period.months += 1
      period.budgetCents += row.budgetCents
      period.spentCents += row.spentCents
    }
    months.push({ month, rows, otherCents, uncategorisedCents, budgetCents: rows.reduce((sum, row) => sum + row.budgetCents, 0), spentCents: rollUp(spending).totals.spendingCents })
  }

  return {
    ...request,
    covers: { from: monthStart(first), to: monthEnd(last) },
    thisMonth: data.thisMonth,
    months,
    total: {
      budgetCents: months.reduce((sum, m) => sum + m.budgetCents, 0),
      spentCents: rollUp(data.spending).totals.spendingCents,
      otherCents: months.reduce((sum, m) => sum + m.otherCents, 0),
      uncategorisedCents: months.reduce((sum, m) => sum + m.uncategorisedCents, 0),
    },
    categories: [...periods.values()].filter((period) => period.months > 0),
  }
}

/** Reads the Report in one D1 batch of three statements (ADR 0004 allows 50). */
export async function readBudgetReport(db: D1Database, request: BudgetReportRequest): Promise<BudgetReport> {
  const first = request.from.slice(0, 7)
  const spending = buildSpending({ from: monthStart(first), to: monthEnd(request.to.slice(0, 7)) })
  const [inEffect, changes, spent] = await db.batch([db.prepare(IN_EFFECT).bind(first), db.prepare(ALL_CHANGES), db.prepare(spending.sql).bind(...spending.binds)])
  return budgetReport(request, {
    inEffect: inEffect!.results as InEffect[],
    changes: changes!.results as Change[],
    spending: spent!.results as SpendingRow[],
    thisMonth: nzMonth(new Date()),
  })
}
