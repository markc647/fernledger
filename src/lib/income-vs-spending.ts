// Relative paths, not `@/`: the Worker's test pins MAX_INCOME_MONTHS to the Worker's by importing this file, and the Worker's compiler has no `@` alias.
import type { MonthState } from '../generated/api/report-budget'
import { lastDay } from './date-range'
import { formatBalance } from './format'
import { monthsTouched } from './report-budget'
import { describeRange } from './report-frame'

// How the Income vs spending by month Report reads what the Worker gives (worker/report-income-vs-spending.ts). The figures are the Worker's: nothing here adds
// up Income or Spending; this file only chooses what to say.

/** The most months a Report covers. The Worker keeps its own copy (worker/report-income-vs-spending.ts); worker/report-income-vs-spending.test.ts pins the two together. */
export const MAX_INCOME_MONTHS = 120

/** What to say, instead of opening the Report, when the dates touch more months than a Report covers; null when they don't. */
export const tooManyIncomeMonths = (from: string, to: string) =>
  monthsTouched(from, to) > MAX_INCOME_MONTHS
    ? `An Income vs spending by month Report covers at most ${MAX_INCOME_MONTHS} months (10 years). Choose dates that touch ${MAX_INCOME_MONTHS} months or fewer.`
    : null

/**
 * The dates the Report counts in `month` ("2026-10") when they are not all of it, in words ("Thu 15 Oct 2026 to Sat 31 Oct 2026"), else null. The first and last
 * month of a Report are part months when its dates do not begin on the 1st or end on the last day, and a reader must not take their figures for whole months.
 */
export function partOfMonth(month: string, from: string, to: string): string | null {
  const start = `${month}-01`
  const end = `${month}-${lastDay(month)}`
  const first = from > start ? from : start
  const last = to < end ? to : end
  return first === start && last === end ? null : describeRange(first, last)
}

/**
 * What a reader needs to know about a month whose figures are not a whole month's yet, so that a row of zeros is not read as a quiet one; null for a month that has
 * ended. The Worker says which (`monthState`, worker/report-budget.ts).
 */
export function monthNote(state: MonthState): string | null {
  if (state === 'under-way') return 'This month is not over yet, so these are the figures so far.'
  if (state === 'not-begun') return 'This month has not begun, so there is nothing to show yet.'
  return null
}

/**
 * Said above the totals when some of the money in has no Category: Uncategorised counts as Spending (ADR 0012), so it comes off Spending and is not Income, and
 * the Difference, which is Income less Spending, does not change whichever way it is categorised. Null when there is none.
 */
export const uncategorisedNotice = (uncategorisedInCents: number) =>
  uncategorisedInCents > 0
    ? `${formatBalance(uncategorisedInCents)} of money in has no Category, so it comes off Spending and isn't counted as Income. Give it an Income Category to count it. The Difference is unaffected.`
    : null

/** What the Difference is called where it is shown as a heading (its column and its total), with what it is, so a figure on its own says it. */
export const DIFFERENCE = 'Difference (income less spending)'

/** The same said as a sentence, for the table's heading on paper, which every printed page repeats. */
export const DIFFERENCE_SENTENCE = 'The Difference is income less spending.'
