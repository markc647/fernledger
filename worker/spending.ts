// Spending and Income are worked out here and nowhere else (ADR 0012), so Budgets, the Reports and the Dashboard can't disagree.
// It is SQL, not a function over fetched rows (ADR 0004): `buildSpending` reads the date index over the range asked for and nothing
// of the history around it (spending.test.ts pins the rows read).
import { isLoansKind, LOANS, UNCATEGORISED_KIND, type CategoryKind } from './category-kinds'
import { effectiveCategory, type EffectiveCategory } from './effective-category'

/** NZ dates, both ends included. `accountId` limits it to one Account. They must have been checked (`isQueryDate`, `isMonth`): they only ever reach SQLite as bound values. */
export type SpendingRange = { from: string; to: string; accountId?: number }

/**
 * One month in one Category. `categoryId` is null for Uncategorised, whose kind is Spending. A month or Category with nothing in it has no row.
 * `categoryName` is the Category's name as a reader is shown it (`shown`: none for Uncategorised, and a removed Category has fallen through to the next),
 * so a caller never looks a name up by ID. `buildSpending` always sets it; a row made by hand in a test may leave it out.
 */
export type SpendingRow = { month: string; categoryId: number | null; categoryName?: string | null; kind: CategoryKind; outCents: number; inCents: number }

/**
 * The statement both of the builders below are made from, so what they leave out and how they read a Transaction is written once: money out and money in over the
 * range, by NZ month and kind (the effective Category's, Spending for Uncategorised) and by `identity`, the columns that say which group of a kind a row is. Transfers
 * are left out (`isTransfer`). A Pending Transaction is stored apart from `transactions`, so it is never read. Rows of a Loans Category come back with `kind: 'loans'`
 * and the callers that total leave them out. The caller prepares it with `binds`: `db.prepare(sql).bind(...binds)`.
 * The columns come in the order month, `identity`, kind, the sums and `extra`, and the groups are the first of them, by position: the joined Categories have columns
 * named kind and name too.
 */
function spendingStatement(range: SpendingRange, identity: (category: EffectiveCategory) => string[], order: string, extra = ''): { sql: string; binds: (string | number)[] } {
  const category = effectiveCategory()
  const binds: (string | number)[] = [range.from, range.to]
  // Only the filters asked for are in the SQL, so an index can serve each one: the date index, or the Account's own date index.
  if (range.accountId !== undefined) binds.push(range.accountId)
  const columns = identity(category)
  const groups = Array.from({ length: columns.length + 2 }, (_, i) => i + 1).join(', ')
  return {
    sql: `SELECT substr(t.date, 1, 7) AS month, ${columns.join(', ')}, COALESCE(${category.shown.kind}, '${UNCATEGORISED_KIND}') AS kind,
                 COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS outCents,
                 COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inCents${extra}
          FROM transactions t ${category.joins}
          WHERE t.date >= ?1 AND t.date <= ?2 ${range.accountId === undefined ? '' : 'AND t.account_id = ?3'} AND NOT ${category.isTransfer}
          -- By position: the joined Categories have columns named kind and name too.
          GROUP BY ${groups}
          ORDER BY ${order}`,
    binds,
  }
}

/** The statement that works out money out and money in for the range, grouped by NZ month and Category, oldest month first (`spendingStatement`). */
export function buildSpending(range: SpendingRange): { sql: string; binds: (string | number)[] } {
  return spendingStatement(range, (category) => [`${category.shown.id} AS categoryId`, `${category.shown.name} AS categoryName`], '1, 2')
}

/**
 * One month of one kind, from `buildMonthlySpending`: the money out and money in of every Transaction of that kind in the month that is not a Transfer, with `uncategorised`
 * 1 for the Transactions that have no Category (their kind is Spending) and 0 for the rest, and `counted`, how many Transactions were added up. A month and kind with nothing in
 * it has no row. A Loans Category's rows come back, with `kind: 'loans'`, and `rollUpMonthly` leaves them out.
 */
export type MonthlyRow = { month: string; uncategorised: 0 | 1; kind: CategoryKind; outCents: number; inCents: number; counted: number }

/**
 * The same statement as `buildSpending` (`spendingStatement`: the same Transfer exclusion, effective Category and kind) grouped by NZ month and kind, and by whether there is
 * a Category at all, instead of by Category: D1 hands the Worker at most four rows a month, however many Categories there are, where `buildSpending` hands it a row for every
 * Category with something in the month (ADR 0004). It reads what `buildSpending` reads. For a Report of months, which never needs a Category (`rollUpMonthly`).
 */
export function buildMonthlySpending(range: SpendingRange): { sql: string; binds: (string | number)[] } {
  return spendingStatement(range, (category) => [`(${category.shown.id} IS NULL) AS uncategorised`], '1, 2, 3', ', COUNT(*) AS counted')
}

/**
 * SQL that is true for a Transaction in a Loans Category, and not for a Transfer: the one definition of "a loan", for a Report that lists loans
 * to use (`WHERE ${isLoan()}`, with `category.joins` in the query). Listing loans needs the Transactions themselves, so it uses this and
 * not the totals `buildSpending` gives. Pass the `effectiveCategory()` the query already uses.
 */
export const isLoan = (category: EffectiveCategory = effectiveCategory()) => `(${category.shown.kind} = '${LOANS}')`

/**
 * One Category's figure for one month: Spending (money out less money in) or Income (money in less money out). Below zero when the other way round.
 * `categoryName` is null for Uncategorised.
 */
export type CategoryFigure = { month: string; categoryId: number | null; categoryName: string | null; kind: 'spending' | 'income'; cents: number }

/** One Category's figure over the whole range: its months added together. A null `categoryId` is Uncategorised. */
export type CategoryTotal = Omit<CategoryFigure, 'month'>

export type MonthTotals = { month: string; spendingCents: number; incomeCents: number }

export type RollUp = {
  /** Each Spending and Income Category with something in a month, in the order the rows came. A Loans Category is not here. */
  categories: CategoryFigure[]
  /** Each of them over all the rows given, so a range of months is not added up by the caller. */
  byCategory: CategoryTotal[]
  /** Spending and Income in all, for each month that has any, in the order the rows came. */
  months: MonthTotals[]
  /** Spending and Income over all the rows given: the months added together, so a range's total is not added up by the caller either. */
  totals: { spendingCents: number; incomeCents: number }
}

/**
 * A row's figure, which is the one place that says which way round it is (ADR 0012): money in less money out for an Income Category, money out less money in for a
 * Spending one (and for Uncategorised), so a refund comes off. Not for a Loans row, which is neither: callers leave those out first (`isLoansKind`).
 */
const centsOf = (row: Pick<SpendingRow, 'kind' | 'outCents' | 'inCents'>) => (row.kind === 'income' ? row.inCents - row.outCents : row.outCents - row.inCents)

/** Spending and Income from the rows of `buildSpending`. */
export function rollUp(rows: SpendingRow[]): RollUp {
  const categories: CategoryFigure[] = []
  const byCategory = new Map<number | null, CategoryTotal>()
  const months = new Map<string, MonthTotals>()
  const totals = { spendingCents: 0, incomeCents: 0 }
  for (const row of rows) {
    if (isLoansKind(row.kind)) continue
    const cents = centsOf(row)
    const categoryName = row.categoryName ?? null
    categories.push({ month: row.month, categoryId: row.categoryId, categoryName, kind: row.kind, cents })
    const category = byCategory.get(row.categoryId) ?? { categoryId: row.categoryId, categoryName, kind: row.kind, cents: 0 }
    category.cents += cents
    byCategory.set(row.categoryId, category)
    const month = months.get(row.month) ?? { month: row.month, spendingCents: 0, incomeCents: 0 }
    if (row.kind === 'income') {
      month.incomeCents += cents
      totals.incomeCents += cents
    } else {
      month.spendingCents += cents
      totals.spendingCents += cents
    }
    months.set(row.month, month)
  }
  return { categories, byCategory: [...byCategory.values()], months: [...months.values()], totals }
}

/** One month of `rollUpMonthly`: Spending and Income, and what a Report of months says besides. */
export type MonthRollUp = MonthTotals & {
  /** Money in that had no Category (Uncategorised): it is in `spendingCents` as money back, and not in `incomeCents`. */
  uncategorisedInCents: number
  /** How many Transactions were counted in the month, Transfers and Loans left out. Zero when none was, however the figures net out: a month of $40 spent and refunded counts two. */
  counted: number
}

export type MonthsRollUp = {
  /** Spending and Income for each month that has any rows, in the order the rows came, as `rollUp`'s `months` have them. */
  months: MonthRollUp[]
  /** Over all the rows given: the months added together, with `counted` and `uncategorisedInCents` added up too. */
  totals: { spendingCents: number; incomeCents: number; uncategorisedInCents: number; counted: number }
}

/**
 * Spending and Income by month and in all from the rows of `buildMonthlySpending`: the same figures `rollUp` gives for the rows of `buildSpending` (the same `centsOf`, and
 * Loans left out the same way), which spending.test.ts holds the two to, over a few rows for each month and not a row for every Category.
 */
export function rollUpMonthly(rows: MonthlyRow[]): MonthsRollUp {
  const months = new Map<string, MonthRollUp>()
  const totals = { spendingCents: 0, incomeCents: 0, uncategorisedInCents: 0, counted: 0 }
  for (const row of rows) {
    if (isLoansKind(row.kind)) continue
    const month = months.get(row.month) ?? { month: row.month, spendingCents: 0, incomeCents: 0, uncategorisedInCents: 0, counted: 0 }
    months.set(row.month, month)
    const cents = centsOf(row)
    if (row.kind === 'income') {
      month.incomeCents += cents
      totals.incomeCents += cents
    } else {
      month.spendingCents += cents
      totals.spendingCents += cents
    }
    if (row.uncategorised === 1) {
      month.uncategorisedInCents += row.inCents
      totals.uncategorisedInCents += row.inCents
    }
    month.counted += row.counted
    totals.counted += row.counted
  }
  return { months: [...months.values()], totals }
}
