import * as z from 'zod/mini'
import { monthCount, nextMonth, nzMonth } from './months'
import { monthState, type MonthState } from './report-budget'
import { accountMissing, datesInOrder, reportRangeOfAll } from './report-query'
import { buildSpending, rollUp, type SpendingRange, type SpendingRow } from './spending'

// The data of the income-vs-spending-by-month Report (GET /api/reports/income-vs-spending): what came in as Income and what was spent as Spending in each NZ
// month of a range of dates, for every Account or for one. It decides nothing about what is Spending or Income (ADR 0012): `buildSpending` reads the range's
// rows and `rollUp` gives each month's figures and the range's, so the Report cannot differ from the Dashboard's chart, Budget vs actual or the Spending by
// Category Report on what it counts. What this file adds is the calendar (a month with nothing in it has a row of zeros, so a gap in the trend is never mistaken
// for missing data, and a month that is not over or has not begun says so), the difference between the two (plain subtraction), and how much of what came in has
// no Category: Uncategorised counts as Spending (ADR 0012), so a wage nobody has given a Category yet comes off Spending instead of counting as Income, and the
// Report says how much that is rather than leave the Difference to be misread.
//
// Cost (ADR 0004): one D1 query for the figures, however many Transactions or months, and one more for an Account named, which is checked first. It reads
// each Transaction in the dates three times (four when a Rule names its Category too), as the Spending by Category Report does. D1 hands back a row for
// each month and Category, which `rollUp` adds in the Worker, and the Report is a row for each month of the dates, at most MAX_INCOME_MONTHS of them (ADR 0004 has what
// the loop costs).

/** The most months a Report covers. The Report page keeps its own copy (src/lib/income-vs-spending.ts); worker/report-income-vs-spending.test.ts pins the two together. */
export const MAX_INCOME_MONTHS = 120

/** The query string of the Report: the dates every Report takes, and an Account when it is for one (all of them when left out). A refusal names the field (`to` for dates out of order or too many months). */
export const incomeVsSpendingQuery = z
  .object(reportRangeOfAll)
  .check(
    datesInOrder,
    z.refine<{ from: string; to: string }>((q) => monthCount(q.from.slice(0, 7), q.to.slice(0, 7)) <= MAX_INCOME_MONTHS, { path: ['to'] }),
  )

/**
 * What came in and what was spent in one NZ month ("2026-10"), in integer cents. `incomeCents` is Income (money in less money out, of the Income Categories) and
 * `spendingCents` is Spending (money out less money in, of the Spending Categories and Uncategorised); either is below zero when the other way round.
 * `differenceCents` (the Report's "Difference") is the first less the second: below zero when more was spent than came in. `uncategorisedInCents` is the money in
 * that had no Category: it is in `spendingCents` (as money back), not in `incomeCents`. `state` says whether the month is over.
 */
export type MonthFigures = { month: string; state: MonthState; incomeCents: number; spendingCents: number; differenceCents: number; uncategorisedInCents: number }

export type IncomeVsSpending = SpendingRange & {
  /** Every month the dates touch, oldest first. The first and last may be only part of a month: they count just the dates in the range. */
  months: MonthFigures[]
  /** Over all the dates: `rollUp`'s totals (the months added together), not added up again here; `uncategorisedInCents` is the months' added together. */
  totals: Omit<MonthFigures, 'month' | 'state'>
}

const figures = (incomeCents: number, spendingCents: number, uncategorisedInCents: number) => ({ incomeCents, spendingCents, differenceCents: incomeCents - spendingCents, uncategorisedInCents })

/** Income and Spending by month from the rows `buildSpending` gave for `range`, with no database. `thisMonth` is the NZ month it is now (`nzMonth`), which decides each month's `state`. */
export function incomeVsSpending(range: SpendingRange, rows: SpendingRow[], thisMonth: string): IncomeVsSpending {
  const { months, totals } = rollUp(rows)
  const read = new Map(months.map((m) => [m.month, m]))
  // Money in that has no Category: Uncategorised is the one Category with no ID, and `rollUp` counts what came in to it against Spending.
  const uncategorisedIn = new Map<string, number>()
  for (const row of rows) if (row.categoryId === null) uncategorisedIn.set(row.month, (uncategorisedIn.get(row.month) ?? 0) + row.inCents)
  const filled: MonthFigures[] = []
  let uncategorisedInCents = 0
  // `buildSpending` reads only the dates in the range, so every month `rollUp` gives is among these.
  for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7); month = nextMonth(month)) {
    const found = read.get(month)
    const uncategorised = uncategorisedIn.get(month) ?? 0
    uncategorisedInCents += uncategorised
    filled.push({ month, state: monthState(month, thisMonth), ...figures(found?.incomeCents ?? 0, found?.spendingCents ?? 0, uncategorised) })
  }
  return { ...range, months: filled, totals: figures(totals.incomeCents, totals.spendingCents, uncategorisedInCents) }
}

/** Reads the range in one D1 statement. The dates must have been checked (`SpendingRange`). `now` is the moment it is made, which decides the NZ month it is now. */
export async function readIncomeVsSpending(db: D1Database, range: SpendingRange, now: Date = new Date()): Promise<IncomeVsSpending | null> {
  // Null when the Account named does not exist, so that is not mistaken for an Account that took in and spent nothing.
  if (await accountMissing(db, range)) return null
  const { sql, binds } = buildSpending(range)
  const { results } = await db.prepare(sql).bind(...binds).all<SpendingRow>()
  return incomeVsSpending(range, results, nzMonth(now))
}
