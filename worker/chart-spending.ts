import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { monthEnd, monthsBefore, monthStart, nzMonth } from './months'
import { buildSpending, rollUp, type SpendingRow } from './spending'

// Spending by Category for a period (GET /api/charts/spending). What counts as Spending, and in which Category, is spending.ts's alone (ADR 0012):
// `buildSpending` reads the period's rows, leaving out Transfers and Pending Transactions, and `rollUp` adds a Category's months together
// and leaves out Income and Loans. This file asks for a period, names the Categories and orders them.
//
// Cost (ADR 0004): two statements, whatever the period. The totals read each Transaction in the dates three times (four when a Rule names its
// Category), so the dearest period, the whole history, reads about four times its Transactions.

/** Periods named by the Worker, because "this month" is a New Zealand month whatever the clock of the browser asking. */
export const SPENDING_PERIODS = ['this-month', 'last-month', 'past-3-months', 'past-12-months'] as const
export type SpendingPeriod = (typeof SPENDING_PERIODS)[number]

/** Whole NZ calendar months, so a period is made of the months ADR 0012 totals by. The past 3 and 12 months end with this month, as far as it has gone. */
export function periodDates(period: SpendingPeriod, now: Date): { from: string; to: string } {
  const month = nzMonth(now)
  switch (period) {
    case 'this-month':
      return { from: monthStart(month), to: monthEnd(month) }
    case 'last-month': {
      const last = monthsBefore(month, 1)
      return { from: monthStart(last), to: monthEnd(last) }
    }
    case 'past-3-months':
      return { from: monthStart(monthsBefore(month, 2)), to: monthEnd(month) }
    case 'past-12-months':
      return { from: monthStart(monthsBefore(month, 11)), to: monthEnd(month) }
  }
}

type Query = { period?: SpendingPeriod | undefined; from?: string | undefined; to?: string | undefined }

/**
 * The query string: a named period, or both dates, but not both and not neither. A refusal names the field to change: `period` when it is
 * given with dates or nothing is given, `from` or `to` when only the other is, and `to` when the dates are the wrong way round.
 */
export const spendingQuery = z
  .object({
    period: z.optional(z.enum(SPENDING_PERIODS)),
    from: z.optional(z.string().check(z.refine(isQueryDate))),
    to: z.optional(z.string().check(z.refine(isQueryDate))),
  })
  .check(
    z.refine<Query>((q) => q.period === undefined || (q.from === undefined && q.to === undefined), { path: ['period'] }),
    z.refine<Query>((q) => q.period !== undefined || q.from !== undefined || q.to === undefined, { path: ['from'] }),
    z.refine<Query>((q) => q.period !== undefined || q.to !== undefined || q.from === undefined, { path: ['to'] }),
    z.refine<Query>((q) => q.period !== undefined || q.from !== undefined || q.to !== undefined, { path: ['period'] }),
    z.refine<Query>((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { path: ['to'] }),
  )

/** The NZ dates the query asks about. The query has been checked, so a period or both dates are there. */
export const rangeOf = (query: Query, now: Date): { from: string; to: string } => (query.period ? periodDates(query.period, now) : { from: query.from!, to: query.to! })

export const UNCATEGORISED_NAME = 'Uncategorised'

/** What one Spending Category spent over the period: money out less money in, so a refund comes off it and it is below zero when more came back. A null `categoryId` is Uncategorised. */
export type SpendingCategory = { categoryId: number | null; name: string; cents: number }

export type SpendingByCategory = {
  from: string
  to: string
  /** Spending in all over the period: the Categories' figures added up. */
  totalCents: number
  /** Each Spending Category with something in the period, the most first, then by name. A Category that took in more than it paid out comes last. */
  categories: SpendingCategory[]
}

/** The Categories in use, whose names the totals give: a Transaction in a removed Category has fallen through to its next Category or Uncategorised (effective-category.ts). */
export const CATEGORY_NAMES = 'SELECT id, name FROM categories WHERE removed_at IS NULL'

/** Spending by Category from the rows `buildSpending` gave and the names of the Categories in use, with no database. */
export function spendingByCategory(range: { from: string; to: string }, rows: SpendingRow[], names: { id: number; name: string }[]): SpendingByCategory {
  const { byCategory, months } = rollUp(rows)
  const nameOf = new Map(names.map((category) => [category.id, category.name]))
  const categories = byCategory
    .filter((total) => total.kind === 'spending')
    .map((total) => {
      const name = total.categoryId === null ? UNCATEGORISED_NAME : nameOf.get(total.categoryId)
      // The names are read in the same batch as the rows, so a Category in the totals is one in use.
      if (name === undefined) throw new Error('A Category in the totals has no name')
      return { categoryId: total.categoryId, name, cents: total.cents }
    })
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  return { ...range, totalCents: months.reduce((sum, month) => sum + month.spendingCents, 0), categories }
}

/** Reads the period in one D1 batch (two statements; ADR 0004 allows 50). */
export async function readSpending(db: D1Database, range: { from: string; to: string }): Promise<SpendingByCategory> {
  const spending = buildSpending(range)
  const [rows, names] = await db.batch([db.prepare(spending.sql).bind(...spending.binds), db.prepare(CATEGORY_NAMES)])
  return spendingByCategory(range, rows!.results as SpendingRow[], names!.results as { id: number; name: string }[])
}
