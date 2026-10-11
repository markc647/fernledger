import { lastDay } from './charts'
import { describeRange } from './report-frame'

// How the Income vs spending by month Report reads what the Worker gives (worker/report-income-vs-spending.ts). The figures are the Worker's: nothing here adds
// up Income or Spending.

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
