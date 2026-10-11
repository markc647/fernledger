import * as z from 'zod/mini'
import { monthCount, monthEnd, monthState, nextMonth, type MonthState } from './months'
import { nzDate } from './nz-time'
import { accountMissing, datesInOrder, reportRangeOfAll } from './report-query'
import { buildMonthlySpending, rollUpMonthly, type MonthlyRow, type SpendingRange } from './spending'

// The data of the income-vs-spending-by-month Report (GET /api/reports/income-vs-spending): what came in as Income and what was spent as Spending in each NZ
// month of a range of dates, for every Account or for one. It decides nothing about what is Spending or Income (ADR 0012): `buildMonthlySpending` is
// `buildSpending`'s statement (spending.ts builds both from one: the same Transfer exclusion, effective Category and kind) grouped by month and kind instead of by
// Category, and `rollUpMonthly` adds its rows with `rollUp`'s own figures, so the Report cannot differ from the Dashboard's chart, Budget vs actual or the Spending by
// Category Report on what it counts (the Report's tests hold it to all of them). What this file adds is the calendar (a month with nothing in it has a row of zeros, so a
// gap in the trend is never mistaken for missing data, and a month that is not over or has not begun says so) and the difference between the two (plain subtraction).
// `rollUpMonthly` also says how much of what came in has no Category: Uncategorised counts as Spending (ADR 0012), so a wage nobody has given a Category yet comes off
// Spending instead of counting as Income, and the Report says how much that is rather than leave the Difference to be misread.
//
// Cost (ADR 0004): one D1 query for the figures, however many Transactions or months, and one more for an Account named, which is checked first. It reads each Transaction
// in the dates as many times as the Spending by Category Report does (three, four when a Rule names its Category too), but D1 hands the Worker at most four rows a month
// (a kind and whether there is a Category), about 480 at the most, and not a row for every Category in every month; the Worker's loop over them is a few hundred
// iterations, and the Report is a row for each month of the dates, at most MAX_INCOME_MONTHS of them (ADR 0004 has the timings).

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
 * that had no Category: it is in `spendingCents` (as money back), not in `incomeCents`. `counted` is how many Transactions were counted in the month (Transfers and
 * Loans left out): zero for a month with no income or spending of any kind, and not zero for a month whose figures net out to nothing, such as $40 spent and refunded. `state` says whether the dates counted in the month are over: 'ended' when every one of them is past, 'not-begun' when none has begun, and
 * 'under-way' when the dates counted run to today or beyond.
 */
export type MonthFigures = { month: string; state: MonthState; incomeCents: number; spendingCents: number; differenceCents: number; uncategorisedInCents: number; counted: number }

export type IncomeVsSpending = SpendingRange & {
  /** Every month the dates touch, oldest first. The first and last may be only part of a month: they count just the dates in the range. */
  months: MonthFigures[]
  /** Over all the dates: `rollUpMonthly`'s totals (the months added together), not added up again here. */
  totals: Omit<MonthFigures, 'month' | 'state'>
}

const figures = (incomeCents: number, spendingCents: number, uncategorisedInCents: number, counted: number) => ({
  incomeCents,
  spendingCents,
  differenceCents: incomeCents - spendingCents,
  uncategorisedInCents,
  counted,
})

/**
 * Income and Spending by month from the rows `buildMonthlySpending` gave for `range`, with no database. `today` is the NZ date it is now (`nzDate`), which decides each month's
 * `state`: the month it is now is under way only while the dates counted in it reach today (a Report of 1 to 15 October opened on 20 October is over for those dates).
 */
export function incomeVsSpending(range: SpendingRange, rows: MonthlyRow[], today: string): IncomeVsSpending {
  const { months, totals } = rollUpMonthly(rows)
  const read = new Map(months.map((m) => [m.month, m]))
  const thisMonth = today.slice(0, 7)
  const filled: MonthFigures[] = []
  // `buildMonthlySpending` reads only the dates in the range, so every month `rollUpMonthly` gives is among these.
  for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7); month = nextMonth(month)) {
    const found = read.get(month)
    let state = monthState(month, thisMonth)
    if (state === 'under-way' && (range.to < monthEnd(month) ? range.to : monthEnd(month)) < today) state = 'ended'
    filled.push({ month, state, ...figures(found?.incomeCents ?? 0, found?.spendingCents ?? 0, found?.uncategorisedInCents ?? 0, found?.counted ?? 0) })
  }
  return { ...range, months: filled, totals: figures(totals.incomeCents, totals.spendingCents, totals.uncategorisedInCents, totals.counted) }
}

/** Reads the range in one D1 statement. The dates must have been checked (`SpendingRange`). `now` is the moment it is made, which decides what day it is now. */
export async function readIncomeVsSpending(db: D1Database, range: SpendingRange, now: Date = new Date()): Promise<IncomeVsSpending | null> {
  // Null when the Account named does not exist, so that is not mistaken for an Account that took in and spent nothing.
  if (await accountMissing(db, range)) return null
  const { sql, binds } = buildMonthlySpending(range)
  const { results } = await db.prepare(sql).bind(...binds).all<MonthlyRow>()
  return incomeVsSpending(range, results, nzDate(now))
}
