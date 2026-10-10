import * as z from 'zod/mini'
import { datesInOrder, reportRangeOfAll } from './report-query'
import { buildSpending, rollUp, type SpendingRow } from './spending'

// The data of the spending-by-Category Report (GET /api/reports/spending): what each Spending Category spent over a range of NZ dates,
// for every Account or for one. It adds up nothing itself. `buildSpending` reads money out and money in by month and Category and
// `rollUp(...).byCategory` adds the months together (ADR 0012), the same two calls as Budget vs actual, so the Report and every page
// that shows spending by Category can't disagree. This file only names the Categories and puts them in order.
//
// Cost (ADR 0004): one request, a batch of two statements (three when an Account is named). The first reads the dates asked for off the
// date index, 3 or 4 rows for each Transaction in them, and returns a row for each month and Category; the second reads the Categories in use.

/** The query string of the Report: the dates every Report takes, and an Account when it is for one (all of them when left out). A refusal names the field. */
export const spendingReportQuery = z.object(reportRangeOfAll).check(datesInOrder)

export type SpendingReportRequest = { accountId?: number; from: string; to: string }

/** A Spending Category and what it spent: money out less money in, so it is below zero when more came back (a refund) than went out. */
export type SpendingLine = { categoryId: number; categoryName: string; cents: number }

export type SpendingReport = {
  /** The Account the figures are for, or null for every Account. */
  accountId: number | null
  /** NZ dates, both ends included. */
  from: string
  to: string
  /** The Spending Categories with a Transaction in the dates, largest first (then by name). Income and Loans Categories are not here. */
  categories: SpendingLine[]
  /** What Uncategorised spent, which counts as Spending and so includes money in that has no Category yet; null when no Transaction in the dates is Uncategorised. */
  uncategorisedCents: number | null
  /** All of it: the Categories and Uncategorised added together. */
  totalCents: number
}

/** The Categories in use. A removed Category is Uncategorised as far as spending goes (effective-category.ts), so it has no name here either. */
const CATEGORY_NAMES = 'SELECT id, name FROM categories WHERE removed_at IS NULL'
const ACCOUNT_EXISTS = 'SELECT id FROM accounts WHERE id = ?'

/** Largest spend first; Categories that spent the same by name, then ID, so the order never depends on how the database returned them. */
const largestFirst = (a: SpendingLine, b: SpendingLine) => b.cents - a.cents || a.categoryName.toLowerCase().localeCompare(b.categoryName.toLowerCase(), 'en-NZ') || a.categoryId - b.categoryId

/**
 * The Report from the rows `buildSpending` gave and the names of the Categories in use, with no database. Only Spending is here:
 * `rollUp` has already left out Loans, and an Income Category is not Spending, so it is dropped too.
 */
export function spendingReport(request: SpendingReportRequest, rows: SpendingRow[], names: { id: number; name: string }[]): SpendingReport {
  const nameOf = new Map(names.map((category) => [category.id, category.name]))
  const categories: SpendingLine[] = []
  let uncategorisedCents: number | null = null
  for (const total of rollUp(rows).byCategory) {
    if (total.kind !== 'spending') continue
    if (total.categoryId === null) {
      uncategorisedCents = total.cents
      continue
    }
    const categoryName = nameOf.get(total.categoryId)
    // The rows and the names are read in one batch, so a Category the rows name is always among the names; the message holds no values.
    if (categoryName === undefined) throw new Error('A Category in the spending has no name')
    categories.push({ categoryId: total.categoryId, categoryName, cents: total.cents })
  }
  categories.sort(largestFirst)
  const totalCents = categories.reduce((sum, line) => sum + line.cents, uncategorisedCents ?? 0)
  return { accountId: request.accountId ?? null, from: request.from, to: request.to, categories, uncategorisedCents, totalCents }
}

/** Reads the Report in one D1 batch (two or three statements; ADR 0004 allows 50). Null when the Account asked for does not exist. */
export async function readSpendingReport(db: D1Database, request: SpendingReportRequest): Promise<SpendingReport | null> {
  const spending = buildSpending(request)
  const statements = [db.prepare(spending.sql).bind(...spending.binds), db.prepare(CATEGORY_NAMES)]
  if (request.accountId !== undefined) statements.push(db.prepare(ACCOUNT_EXISTS).bind(request.accountId))
  const [rows, names, account] = await db.batch(statements)
  if (account !== undefined && account.results.length === 0) return null
  return spendingReport(request, rows!.results as SpendingRow[], names!.results as { id: number; name: string }[])
}
