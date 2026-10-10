// The one definition of spending: what Budget vs actual, the Reports and the dashboard total, so none of them can disagree.
//
// Spending in a Category in an NZ calendar month is every settled Transaction in that Category and month that is not a Transfer:
//   - Category: the effective Category as a reader sees it (`effectiveCategory().shown`): Override, then Rule, then Akahu, else none
//     (Uncategorised, `categoryId` null). A removed Category counts as none.
//   - Not a Transfer: `effectiveCategory().isTransfer`, never a version of "paired, or a Rule marks it" of its own (CODING_STANDARDS.md).
//     A Transaction the Admin has given a Category by Override is spending in it, even if it was paired (effective-category.ts).
//   - Not Pending: a Pending Transaction is stored apart from `transactions` (spec #1) and replaced on every Sync, so this never reads one.
//   - Month: the first seven characters of the Transaction's date, which is already an NZ date (months.ts).
//
// Money out and money in are kept apart (`outCents`, `inCents`), because the Reports need both (income vs spending by month).
// What a Category has SPENT is money out less money in (`spentCents`): a refund reduces it, as the Admin expects of a returned
// purchase, and a Category that took in more than it paid out is below zero. Budget vs actual shows exactly that figure.
// Only the Transactions that are not Transfers count in either direction, so a payment into the Savings Account is not
// "money in" and the matching payment out of Everyday is not "money out".
//
// It is SQL, not a function over fetched rows (ADR 0004), and it reads one range of the date index: the Transactions of the months
// asked for, and nothing of the history around them (spending.test.ts pins the rows read).
import { effectiveCategory } from './effective-category'
import { monthStart, nextMonth } from './months'

/** Both ends included, as `YYYY-MM` NZ months. */
export type SpendingRange = { fromMonth: string; toMonth: string }

/** One month in one Category. `categoryId` is null for Uncategorised. A month or Category with nothing in it has no row. */
export type SpendingRow = { month: string; categoryId: number | null; outCents: number; inCents: number }

/** What the Category spent in the month: money out less money in, in cents. Below zero when more came in than went out. */
export const spentCents = (row: Pick<SpendingRow, 'outCents' | 'inCents'>) => row.outCents - row.inCents

/**
 * The statement that works out spending for the months in `range`, oldest month first. The caller prepares it with `binds`:
 * `db.prepare(sql).bind(...binds)`. The months must have been checked with `isMonth`; they only ever reach SQLite as bound values.
 */
export function buildSpending(range: SpendingRange): { sql: string; binds: string[] } {
  const category = effectiveCategory()
  return {
    sql: `SELECT substr(t.date, 1, 7) AS month, ${category.shown.id} AS categoryId,
                 COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS outCents,
                 COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inCents
          FROM transactions t ${category.joins}
          WHERE t.date >= ?1 AND t.date < ?2 AND NOT ${category.isTransfer}
          GROUP BY month, categoryId
          ORDER BY month, categoryId`,
    binds: [monthStart(range.fromMonth), monthStart(nextMonth(range.toMonth))],
  }
}
