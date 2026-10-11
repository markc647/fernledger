import * as z from 'zod/mini'
import { ALL_CHANGES, budgetInMonth, budgetVsActual, IN_EFFECT, withChanges, type Change, type InEffect, type VsActual } from './budget-rules'
import { monthCount, monthEnd, monthStart, monthState, nextMonth, nzMonth, type MonthState } from './months'
import { datesInOrder, reportDates } from './report-query'
import { buildSpending, rollUp, type SpendingRow } from './spending'

// The data of the Budget vs actual Report (GET /api/reports/budget-vs-actual): each NZ month the dates touch, whole, with the Budget each Spending
// Category had in it and what it spent. Nothing is worked out here that Budgets and Spending have not already decided:
// - the Budget in a month is budget-rules.ts's `budgetInMonth` (the latest change on or before the month, nothing carried over), applied to each
//   month, and a month is compared with its spending by the Summary's own `budgetVsActual`, so a month of the Report is a month of the widget;
// - Spending is spending.ts's `buildSpending` and `rollUp` (ADR 0012), read once for all the months, so a Transfer, a Pending Transaction, Income
//   and Loans are left out as they are everywhere else, and the Report's total is `rollUp`'s, not a sum of its months.
// A Budget is for all Accounts together, so the Report is too: it takes no Account.
//
// The months together count only the months that have ended. The month it is now has had part of its spending against the whole of its Budget, and a month
// to come has none against all of its, so setting them beside the months that are over would make the Categories look further under Budget than they are.
// Those months are in the Report, each on its own and marked, but not in the totals (`together` says which months the totals cover).
//
// A Category is as it is now: a Category changed from Spending to Income, or removed, is out of every month, past ones too (ADR 0012), like the Summary's.
//
// Cost (ADR 0004): one D1 batch of three statements whatever the dates (the Spending Categories with every Budget change, which is at most
// MAX_BUDGET_CHANGES rows, and the spending), and the spending reads each Transaction in the months three times, four with a Rule's Category.
// The months are capped so the loop and the response stay small: at most the Categories with a Budget (at most MAX_BUDGET_CHANGES) for each of them.
// worker/report-budget.test.ts pins the statements and the rows read.

/** The most months a Report covers. The Report page keeps its own copy (src/lib/report-budget.ts); worker/report-budget.test.ts pins the two together. */
export const MAX_REPORT_MONTHS = 24

/** The Report's query string: the dates every Report takes, both ends included, with no Account. A refusal names the field (`to` for dates out of order or too many months). */
export const budgetReportQuery = z
  .object(reportDates)
  .check(
    datesInOrder,
    z.refine<{ from: string; to: string }>((q) => monthCount(q.from.slice(0, 7), q.to.slice(0, 7)) <= MAX_REPORT_MONTHS, { path: ['to'] }),
  )

export type BudgetReportRequest = { from: string; to: string }

/**
 * Whether a Category (or the Budgets together) spent more than its Budget: the Summary's "Over Budget". `budgetStatus` in src/lib/budgets.ts words it, and
 * worker/report-budget.test.ts holds the two to the same answer. Exactly the Budget is not over.
 */
export const isOver = (budgetCents: number, spentCents: number) => spentCents > budgetCents

/**
 * A Category with a Budget in a month, as the Summary has it, with the month that Budget began (`effectiveFrom`) and whether it is a change: the Category had a
 * different Budget the month before in this Report. A Report's first month is never a change, because nothing before it is shown.
 */
export type MonthRow = VsActual & { effectiveFrom: string; changed: boolean }

/** One month of the Report. */
export type ReportMonth = {
  /** `YYYY-MM`. */
  month: string
  state: MonthState
  /** Each Spending Category that has a Budget in the month, with what it spent. */
  rows: MonthRow[]
  /** What the Spending Categories with no Budget in the month spent. */
  otherCents: number
  /** What Uncategorised spent, which counts as Spending and so includes money in that has no Category yet. */
  uncategorisedCents: number
  /** The month's Budgets added up. */
  budgetCents: number
  /** What the Categories with a Budget spent, added up: the rows' figures, which the Budgets are fairly set against. */
  budgetedSpentCents: number
  /** All Spending in the month (`rollUp`'s), which the rows, `otherCents` and `uncategorisedCents` add up to. */
  spentCents: number
}

/**
 * A Category over the months together: its Budgets added up over the months it had one, what it spent in those months, and in how many it was over its
 * Budget. Its spending in a month with no Budget is in `otherCents`.
 */
export type CategoryPeriod = { categoryId: number; categoryName: string; months: number; overMonths: number; budgetCents: number; spentCents: number }

export type BudgetReport = {
  /** The dates asked for. */
  from: string
  to: string
  /** The dates the Report covers: the whole of every month the dates touch. */
  covers: { from: string; to: string }
  /** Every month the dates touch, oldest first, including a month with nothing in it. */
  months: ReportMonth[]
  /** The months the totals below cover: the months that have ended, which are the first ones. Null while none has. */
  together: { first: string; last: string; months: number } | null
  /**
   * The ended months together. `spentCents` is `rollUp`'s total over their rows, which their months' totals add up to. `budgetMonths` is how many of them had any
   * Budget and `overMonths` in how many the Budgets together were overspent.
   */
  total: { budgetCents: number; budgetedSpentCents: number; spentCents: number; otherCents: number; uncategorisedCents: number; budgetMonths: number; overMonths: number }
  /** Each Category that had a Budget in some ended month, over the ended months, in the Summary's order (by name). */
  categories: CategoryPeriod[]
}

/**
 * The Report from what D1 gave, with no database: the Spending Categories in use (`inEffect`, of which only the Categories are used; the amounts are
 * for one month), every Budget change, the range's spending rows, and the NZ month it is now. Months are `YYYY-MM`, which compare correctly as text.
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
  const spentIn = new Map(rollUp(data.spending).months.map((m) => [m.month, m.spendingCents]))

  const periods = new Map<number, CategoryPeriod>(categories.map((c) => [c.categoryId, { categoryId: c.categoryId, categoryName: c.categoryName, months: 0, overMonths: 0, budgetCents: 0, spentCents: 0 }]))
  const total = { budgetCents: 0, budgetedSpentCents: 0, spentCents: 0, otherCents: 0, uncategorisedCents: 0, budgetMonths: 0, overMonths: 0 }
  const months: ReportMonth[] = []
  let before: Map<number, number> | null = null // the Budget each Category had the month before, in this Report
  for (let month = first; month <= last; month = nextMonth(month)) {
    const inMonth = categories.map((c): InEffect => ({ categoryId: c.categoryId, categoryName: c.categoryName, ...budgetInMonth(c.changes, month) }))
    const began = new Map(inMonth.map((c) => [c.categoryId, c.effectiveFrom!]))
    const { rows, otherCents, uncategorisedCents } = budgetVsActual(inMonth, rowsOf.get(month) ?? [])
    const state = monthState(month, data.thisMonth)
    const budgetCents = rows.reduce((sum, row) => sum + row.budgetCents, 0)
    const budgetedSpentCents = rows.reduce((sum, row) => sum + row.spentCents, 0)
    months.push({
      month,
      state,
      rows: rows.map((row) => ({ ...row, effectiveFrom: began.get(row.categoryId)!, changed: before !== null && before.has(row.categoryId) && before.get(row.categoryId) !== row.budgetCents })),
      otherCents,
      uncategorisedCents,
      budgetCents,
      budgetedSpentCents,
      spentCents: spentIn.get(month) ?? 0,
    })
    before = new Map(rows.map((row) => [row.categoryId, row.budgetCents]))
    if (state !== 'ended') continue

    for (const row of rows) {
      const period = periods.get(row.categoryId)!
      period.months += 1
      period.overMonths += Number(isOver(row.budgetCents, row.spentCents))
      period.budgetCents += row.budgetCents
      period.spentCents += row.spentCents
    }
    total.budgetCents += budgetCents
    total.budgetedSpentCents += budgetedSpentCents
    total.otherCents += otherCents
    total.uncategorisedCents += uncategorisedCents
    if (rows.length > 0) {
      total.budgetMonths += 1
      total.overMonths += Number(isOver(budgetCents, budgetedSpentCents))
    }
  }
  const ended = months.filter((m) => m.state === 'ended')
  total.spentCents = rollUp(data.spending.filter((row) => row.month < data.thisMonth)).totals.spendingCents

  return {
    ...request,
    covers: { from: monthStart(first), to: monthEnd(last) },
    months,
    together: ended.length === 0 ? null : { first: ended[0]!.month, last: ended.at(-1)!.month, months: ended.length },
    total,
    categories: [...periods.values()].filter((period) => period.months > 0),
  }
}

/** Reads the Report in one D1 batch of three statements (ADR 0004 allows 50). `now` is the moment it is made, which decides the NZ month it is now. */
export async function readBudgetReport(db: D1Database, request: BudgetReportRequest, now: Date = new Date()): Promise<BudgetReport> {
  const first = request.from.slice(0, 7)
  const spending = buildSpending({ from: monthStart(first), to: monthEnd(request.to.slice(0, 7)) })
  const [inEffect, changes, spent] = await db.batch([db.prepare(IN_EFFECT).bind(first), db.prepare(ALL_CHANGES), db.prepare(spending.sql).bind(...spending.binds)])
  return budgetReport(request, {
    inEffect: inEffect!.results as InEffect[],
    changes: changes!.results as Change[],
    spending: spent!.results as SpendingRow[],
    thisMonth: nzMonth(now),
  })
}
