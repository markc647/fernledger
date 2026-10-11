import * as z from 'zod/mini'
import { nextMonth } from './months'
import { accountMissing, datesInOrder, reportRangeOfAll } from './report-query'
import { buildSpending, rollUp, type SpendingRange, type SpendingRow } from './spending'

// The data of the income-vs-spending-by-month Report (GET /api/reports/income-vs-spending): what came in as Income and what was spent as Spending in each NZ
// month of a range of dates, for every Account or for one. It decides nothing about what is Spending or Income (ADR 0012): `buildSpending` reads the range's
// rows and `rollUp` gives each month's figures and the range's, so the Report cannot differ from the Dashboard's chart, Budget vs actual or the Spending by
// Category Report on what it counts. The only things this file adds are the calendar (a month with nothing in it has a row of zeros, so a gap in the trend
// is never mistaken for missing data) and the difference between the two, which is plain subtraction.
//
// Cost (ADR 0004): one D1 query for the figures, however many Transactions or months, and one more for an Account named, which is checked first. It reads
// each Transaction in the dates three times (four when a Rule names its Category too), as the Spending by Category Report does. D1 hands back a row for
// each month and Category, which `rollUp` adds in the Worker, and the Report is a row for each month of the dates (at most 1,212: the years a date accepts).

/** The query string of the Report: the dates every Report takes, and an Account when it is for one (all of them when left out). A refusal names the field. */
export const incomeVsSpendingQuery = z.object(reportRangeOfAll).check(datesInOrder)

/**
 * What came in and what was spent in one NZ month ("2026-10"), in integer cents. `incomeCents` is Income (money in less money out, of the Income Categories) and
 * `spendingCents` is Spending (money out less money in, of the Spending Categories and Uncategorised); either is below zero when the other way round.
 * `differenceCents` is the first less the second: below zero when more was spent than came in.
 */
export type MonthFigures = { month: string; incomeCents: number; spendingCents: number; differenceCents: number }

export type IncomeVsSpending = SpendingRange & {
  /** Every month the dates touch, oldest first. The first and last may be only part of a month: they count just the dates in the range. */
  months: MonthFigures[]
  /** Over all the dates: `rollUp`'s totals (the months added together), not added up again here. */
  totals: Omit<MonthFigures, 'month'>
}

const figures = (incomeCents: number, spendingCents: number) => ({ incomeCents, spendingCents, differenceCents: incomeCents - spendingCents })

/** Income and Spending by month from the rows `buildSpending` gave for `range`, with no database. */
export function incomeVsSpending(range: SpendingRange, rows: SpendingRow[]): IncomeVsSpending {
  const { months, totals } = rollUp(rows)
  const read = new Map(months.map((m) => [m.month, m]))
  const filled: MonthFigures[] = []
  // `buildSpending` reads only the dates in the range, so every month `rollUp` gives is among these.
  for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7); month = nextMonth(month)) {
    const found = read.get(month)
    filled.push({ month, ...figures(found?.incomeCents ?? 0, found?.spendingCents ?? 0) })
  }
  return { ...range, months: filled, totals: figures(totals.incomeCents, totals.spendingCents) }
}

/** Reads the range in one D1 statement. The dates must have been checked (`SpendingRange`). */
export async function readIncomeVsSpending(db: D1Database, range: SpendingRange): Promise<IncomeVsSpending | null> {
  // Null when the Account named does not exist, so that is not mistaken for an Account that took in and spent nothing.
  if (await accountMissing(db, range)) return null
  const { sql, binds } = buildSpending(range)
  const { results } = await db.prepare(sql).bind(...binds).all<SpendingRow>()
  return incomeVsSpending(range, results)
}
