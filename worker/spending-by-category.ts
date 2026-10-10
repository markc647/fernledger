import { buildSpending, rollUp, type SpendingRange, type SpendingRow } from './spending'

// Spending by Category over a range of NZ dates: one function for everything that shows it, so the chart (chart-spending.ts) and a Report of it can't
// differ in what they leave out, how they name a Category or how they order them. What counts as Spending, and in which Category, is spending.ts's alone
// (ADR 0012): `buildSpending` reads the range's rows with each Category's name as a reader is shown it (so there is no lookup by ID, and a removed Category
// has already fallen through to the next one or to Uncategorised), and `rollUp` adds its months together and leaves out Transfers, Income and Loans.
//
// Cost (ADR 0004): one statement, whatever the range. It reads each Transaction in the dates three times (four when a Rule names its Category too).
// A Report asks for the range its `reportRange` validated, and for one Account when it is about one (`accountId`).

/** What Uncategorised is called where a Category's name would be. */
export const UNCATEGORISED_NAME = 'Uncategorised'

/** What one Spending Category spent over the range: money out less money in, so a refund comes off it and it is below zero when more came back. A null `categoryId` is Uncategorised. */
export type SpendingCategory = { categoryId: number | null; name: string; cents: number }

export type SpendingByCategory = SpendingRange & {
  /** Spending in all over the range: `rollUp`'s total, which the Categories' figures add up to. */
  totalCents: number
  /** Each Spending Category with something in the range, in `byFigure` order. */
  categories: SpendingCategory[]
}

/**
 * The one order for Spending Categories, so the Dashboard and a Report put the same figures in the same order: the most spent first (so a Category that
 * took in more than it paid out is last), and among equal amounts the named Categories by name, ignoring capitals and accents (`en-NZ`), with Uncategorised after
 * them and a Category's ID the last tiebreak, which settles two with one name.
 */
export const byFigure = (a: SpendingCategory, b: SpendingCategory) =>
  b.cents - a.cents ||
  Number(a.categoryId === null) - Number(b.categoryId === null) ||
  a.name.localeCompare(b.name, 'en-NZ', { sensitivity: 'base' }) ||
  (a.categoryId ?? 0) - (b.categoryId ?? 0)

/** Spending by Category from the rows `buildSpending` gave, with no database. Only Spending Categories are here (`rollUp` leaves out Loans, and Income is not Spending), and the total is `rollUp`'s. */
export function spendingByCategory(range: SpendingRange, rows: SpendingRow[]): SpendingByCategory {
  const { byCategory, totals } = rollUp(rows)
  const categories = byCategory
    .filter((category) => category.kind === 'spending')
    .map((category) => {
      const name = category.categoryId === null ? UNCATEGORISED_NAME : category.categoryName
      // `buildSpending` names every Category it gives an ID, so only a row made without its name gets here.
      if (name === null || name === undefined) throw new Error('A Category in the totals has no name')
      return { categoryId: category.categoryId, name, cents: category.cents }
    })
    .sort(byFigure)
  return { ...range, totalCents: totals.spendingCents, categories }
}

/** Reads the range in one D1 statement. The dates must have been checked (`SpendingRange`). */
export async function readSpendingByCategory(db: D1Database, range: SpendingRange): Promise<SpendingByCategory> {
  const { sql, binds } = buildSpending(range)
  const { results } = await db.prepare(sql).bind(...binds).all<SpendingRow>()
  return spendingByCategory(range, results)
}
