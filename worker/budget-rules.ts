// What a Budget is: the shape the API takes, the one SQL definition of "the Budget in a month", how it is compared with
// spending, and how a change reads in the Change Log. The routes (budgets.ts) and the tests build on these.
import * as z from 'zod/mini'
import { isMonth, monthLabel } from './months'
import { dollars, MAX_AMOUNT_CENTS } from './rule-criteria'
import { rollUp, type SpendingRow } from './spending'

/**
 * The most Budget changes the database holds in all (rows of `budgets`), for good: a change is replaced, never removed. The Budgets
 * page reads every one (ADR 0004: D1 bills rows read), and 600 is a change every month for two years in 25 Categories, far past what a
 * family sets. The page says how many are used as it nears the limit.
 */
export const MAX_BUDGET_CHANGES = 600

/**
 * Sets a Category's Budget from a month on. `amountCents` is a whole number of cents above zero, or `null` to end the Budget
 * from that month. Both must be there, so a request that leaves the amount out is refused rather than ending a Budget.
 */
export const budgetBody = z.object({
  effectiveFrom: z.string().check(z.refine(isMonth)),
  amountCents: z.nullable(z.int().check(z.positive(), z.maximum(MAX_AMOUNT_CENTS))),
})

/** The month `/api/budgets` and `/api/budgets/vs-actual` are asked about; the current NZ month when left out. */
export const monthQuery = z.object({ month: z.optional(z.string().check(z.refine(isMonth))) })

/** One Category and the Budget in effect for it in a month. `amountCents` is null while it has none; `effectiveFrom` is the month that Budget began. */
export type InEffect = { categoryId: number; categoryName: string; amountCents: number | null; effectiveFrom: string | null }

/** A row of `budgets`. */
export type Change = { categoryId: number; effectiveFrom: string; amountCents: number | null }

/**
 * SQL for the month of the LATEST row of a Category's Budget on or before a month: the one rule that says which Budget a month
 * has. `category` and `month` are SQL expressions (a column or a numbered parameter), interpolated, so they must be constants
 * written in the calling code, never anything from a request. One seek on the primary key, however many changes there are (ADR 0004).
 */
export const latestMonth = (category: string, month: string) =>
  `(SELECT effective_from_month FROM budgets WHERE category_id = ${category} AND effective_from_month <= ${month} ORDER BY effective_from_month DESC LIMIT 1)`

/**
 * The Budget in effect in month ?1 for every Spending Category in use (Budgets are for those only, ADR 0012). A Category with no row on or
 * before the month has no Budget, and neither has one whose latest row has no amount (it ended). Nothing carries over: only the one row
 * decides the month. The month is only ever bound. `budgetInMonth` is the same rule for changes already read; budget-rules.test.ts
 * checks that the two agree.
 */
export const IN_EFFECT = `
  SELECT c.id AS categoryId, c.name AS categoryName, b.amount_cents AS amountCents, b.effective_from_month AS effectiveFrom
  FROM categories c
  LEFT JOIN budgets b ON b.category_id = c.id AND b.effective_from_month = ${latestMonth('c.id', '?1')}
  WHERE c.removed_at IS NULL AND c.kind = 'spending'
  ORDER BY c.name COLLATE NOCASE, c.id`

/** Every Budget change, oldest month first within each Category. Bounded by MAX_BUDGET_CHANGES. */
export const ALL_CHANGES = `SELECT category_id AS categoryId, effective_from_month AS effectiveFrom, amount_cents AS amountCents FROM budgets ORDER BY category_id, effective_from_month`

export type BudgetView = InEffect & { changes: { effectiveFrom: string; amountCents: number | null }[] }

/** Each Category with its own changes (those of a removed Category are dropped with it), in the order the Categories came. */
export function withChanges(inEffect: InEffect[], changes: Change[]): BudgetView[] {
  const byCategory = new Map<number, BudgetView['changes']>(inEffect.map((row) => [row.categoryId, []]))
  for (const change of changes) byCategory.get(change.categoryId)?.push({ effectiveFrom: change.effectiveFrom, amountCents: change.amountCents })
  return inEffect.map((row) => ({ ...row, changes: byCategory.get(row.categoryId)! }))
}

/** The Budget a month has, from a Category's changes in any order: the one whose month is the latest on or before it. */
export function budgetInMonth(changes: { effectiveFrom: string; amountCents: number | null }[], month: string): { amountCents: number | null; effectiveFrom: string | null } {
  let latest: (typeof changes)[number] | null = null
  for (const change of changes) if (change.effectiveFrom <= month && (latest === null || change.effectiveFrom > latest.effectiveFrom)) latest = change
  return latest === null ? { amountCents: null, effectiveFrom: null } : { amountCents: latest.amountCents, effectiveFrom: latest.effectiveFrom }
}

export type VsActual = { categoryId: number; categoryName: string; budgetCents: number; spentCents: number }

/**
 * Budget vs actual for one month: each Spending Category that has a Budget in it, with what it spent (ADR 0012; `spending` is that one
 * month's rows). `otherCents` is what the rest spent: Uncategorised and the Spending Categories with no Budget, so a Member sees the
 * whole of the spending and not only the part that has a Budget.
 */
export function budgetVsActual(inEffect: InEffect[], spending: SpendingRow[]): { rows: VsActual[]; otherCents: number } {
  const spent = new Map<number | null, number>()
  for (const figure of rollUp(spending).categories) if (figure.kind === 'spending') spent.set(figure.categoryId, figure.cents)
  const rows = inEffect.flatMap((row) => (row.amountCents === null ? [] : [{ categoryId: row.categoryId, categoryName: row.categoryName, budgetCents: row.amountCents, spentCents: spent.get(row.categoryId) ?? 0 }]))
  for (const row of rows) spent.delete(row.categoryId)
  return { rows, otherCents: [...spent.values()].reduce((sum, cents) => sum + cents, 0) }
}

/** A change as the Change Log shows it, in plain words and dollars: the page shows what is recorded as it is. `before` is the Budget in effect that month. */
export function describeChange(categoryName: string, month: string, before: number | null, after: number | null) {
  const record = (amountCents: number | null) => ({ category: categoryName, fromMonth: monthLabel(month), monthlyBudget: amountCents === null ? null : dollars(amountCents) })
  const summary =
    after === null
      ? `Ended the Budget for ${categoryName} from ${monthLabel(month)}`
      : before === null
        ? `Set the Budget for ${categoryName} to ${dollars(after)} a month from ${monthLabel(month)}`
        : `Changed the Budget for ${categoryName} from ${dollars(before)} to ${dollars(after)} a month from ${monthLabel(month)}`
  return { summary, before: record(before), after: record(after) }
}
