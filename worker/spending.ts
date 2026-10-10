// The one place Spending and Income are worked out: what Budget vs actual, the Reports and the dashboard total, so none of them can
// disagree. The rules, and why, are ADR 0012 (docs/adr/0012-spending-and-category-kinds.md); this file is how they are written.
//
//   buildSpending  SQL: money out and money in for each NZ month and Category in a date range, for all Accounts or one.
//   rollUp         turns those rows into Spending and Income figures, per Category and per month. Totals come from here.
//
// Rows for a Loans-kind Category come back from `buildSpending` too, with `kind: 'loans'`: `rollUp` leaves them out of every
// total, and the Loans Report (#38) reads them straight from the rows.
//
// It is SQL, not a function over fetched rows (ADR 0004), and it reads the date index over the range asked for and nothing
// of the history around it (spending.test.ts pins the rows read).
import { UNCATEGORISED_KIND, type CategoryKind } from './category-kinds'
import { effectiveCategory } from './effective-category'

/** NZ dates, both ends included. `accountId` limits it to one Account. They must have been checked (`isQueryDate`, `isMonth`): they only ever reach SQLite as bound values. */
export type SpendingRange = { from: string; to: string; accountId?: number }

/** One month in one Category. `categoryId` is null for Uncategorised, whose kind is Spending. A month or Category with nothing in it has no row. */
export type SpendingRow = { month: string; categoryId: number | null; kind: CategoryKind; outCents: number; inCents: number }

/**
 * The statement that works out money out and money in for the range, grouped by NZ month and Category, oldest month first.
 * Transfers are left out (`isTransfer`), and a Transaction's Category and kind are its effective Category's (`shown`). The caller
 * prepares it with `binds`: `db.prepare(sql).bind(...binds)`. A Pending Transaction is stored apart from `transactions`, so it is never read.
 */
export function buildSpending(range: SpendingRange): { sql: string; binds: (string | number)[] } {
  const category = effectiveCategory()
  const binds: (string | number)[] = [range.from, range.to]
  // Only the filters asked for are in the SQL, so an index can serve each one: the date index, or the Account's own date index.
  if (range.accountId !== undefined) binds.push(range.accountId)
  return {
    sql: `SELECT substr(t.date, 1, 7) AS month, ${category.shown.id} AS categoryId, COALESCE(${category.shown.kind}, '${UNCATEGORISED_KIND}') AS kind,
                 COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS outCents,
                 COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inCents
          FROM transactions t ${category.joins}
          WHERE t.date >= ?1 AND t.date <= ?2 ${range.accountId === undefined ? '' : 'AND t.account_id = ?3'} AND NOT ${category.isTransfer}
          -- By position: the joined Categories have a column named kind too.
          GROUP BY 1, 2, 3
          ORDER BY 1, 2`,
    binds,
  }
}

/** One Category's figure for one month: Spending (money out less money in) or Income (money in less money out). Below zero when the other way round. */
export type CategoryFigure = { month: string; categoryId: number | null; kind: 'spending' | 'income'; cents: number }

export type MonthTotals = { month: string; spendingCents: number; incomeCents: number }

export type RollUp = {
  /** Each Spending and Income Category with something in a month, in the order the rows came. A Loans Category is not here. */
  categories: CategoryFigure[]
  /** Spending and Income in all, for each month that has any, in the order the rows came. */
  months: MonthTotals[]
}

/** Spending and Income from the rows of `buildSpending`. */
export function rollUp(rows: SpendingRow[]): RollUp {
  const categories: CategoryFigure[] = []
  const months = new Map<string, MonthTotals>()
  for (const row of rows) {
    if (row.kind === 'loans') continue
    const cents = row.kind === 'income' ? row.inCents - row.outCents : row.outCents - row.inCents
    categories.push({ month: row.month, categoryId: row.categoryId, kind: row.kind, cents })
    const total = months.get(row.month) ?? { month: row.month, spendingCents: 0, incomeCents: 0 }
    if (row.kind === 'income') total.incomeCents += cents
    else total.spendingCents += cents
    months.set(row.month, total)
  }
  return { categories, months: [...months.values()] }
}
