import * as z from 'zod/mini'
import { datesInOrder, reportRangeOfAll } from './report-query'
import type { SpendingRange } from './spending'
import { readSpendingByCategory, type SpendingByCategory } from './spending-by-category'

// The data of the spending-by-Category Report (GET /api/reports/spending): what each Spending Category spent over a range of NZ dates, for every Account
// or for one. It works out nothing and names, orders and totals nothing: `readSpendingByCategory` (spending-by-category.ts) does all of that, and is the
// function the Dashboard's chart calls too, so the two give the same Categories, in the same order, with the same total (ADR 0012). This file is only
// the query string that asks, and the check that the Account asked about exists.
//
// Cost (ADR 0004): one D1 query for the figures, whatever the number of Transactions, and one more for an Account named, which is checked first.

/** The query string of the Report: the dates every Report takes, and an Account when it is for one (all of them when left out). A refusal names the field. */
export const spendingReportQuery = z.object(reportRangeOfAll).check(datesInOrder)

const ACCOUNT_EXISTS = 'SELECT id FROM accounts WHERE id = ?'

/** The Report: `readSpendingByCategory`'s answer for the range. Null when the Account named does not exist, so that is not mistaken for an Account that spent nothing. */
export async function readSpendingReport(db: D1Database, range: SpendingRange): Promise<SpendingByCategory | null> {
  if (range.accountId !== undefined && !(await db.prepare(ACCOUNT_EXISTS).bind(range.accountId).first())) return null
  return readSpendingByCategory(db, range)
}
