import * as z from 'zod/mini'
import { findCategory } from './categories'
import { isLoansKind } from './category-kinds'
import { categoryCandidates, effectiveCategory } from './effective-category'
import { reportDates, reportId } from './report-query'
import { pageOf, pagingFields, toPaging } from './report-transactions'
import { isLoan } from './spending'
import type { Statement } from './transaction-search'

// The data of the Loans Report (GET /api/reports/loans): the Transactions of one Loans Category, oldest first, from the first Transaction or a start date up
// to a date, a page at a time. The Report page asks for each Loans Category in turn (src/lib/report-loans.ts), so "all of them" is one request a page for each.
//
// What a loan is comes from `isLoan` (spending.ts) over `effectiveCategory().shown` (effective-category.ts) and from `isLoansKind` (category-kinds.ts), and from
// nowhere else: this file never reads `transfer_of`, `rule_transfer` or `not_transfer_with`. So a Transfer half the Admin gave a Loans Category is a loan (an
// Override outranks a Transfer), a Transaction marked Not a Transfer counts under its own Category's kind, and a Transfer is not a loan, exactly as
// `buildSpending` sets Loans apart from Spending and Income (worker/report-loans.test.ts holds the two together).
//
// Cost (ADR 0004): the Category's own Transactions are found through the indexes on `override_category` and `rule_category`, the way a Category filter on the
// Transactions list finds them (transaction-search.ts), so a request reads this Category's Transactions and not the history around them. But a page statement
// reads all of them, since they are put in date order after they are found, and so does the opening balance. So a loan costs about its size for each page, and a
// page is large (`LOANS_PAGE_SIZE`) and the Report short (`LOANS_ROW_CAP`), so that a family's loan, which is tens or hundreds of Transactions, is one request.

/** The most Transactions in a page of the Loans Report, and the size of one when the request doesn't say. Larger than the Transaction listing's 200, because each page re-reads the loan. The Report page keeps its own copy (src/lib/report-loans.ts). */
export const LOANS_PAGE_SIZE = 1000

/** The last check of the Loans Report's query: `from`, when there is one, is not after `to`. A refusal names `to`. (`datesInOrder` is for the Reports that must have both.) */
const startIsNotAfterEnd = z.refine<{ from?: string; to: string }>((q) => q.from === undefined || q.from <= q.to, { path: ['to'] })

/** The query string: a Loans Category, the dates (the start is optional: without it the Report begins at the first Transaction), and the page. A refusal names the field. */
export const loansQuery = z.object({ categoryId: reportId, from: z.optional(reportDates.from), to: reportDates.to, ...pagingFields }).check(startIsNotAfterEnd)

export type LoansQuery = {
  categoryId: number
  /** NZ dates, both ends included. Left out, the Report begins at the first Transaction. */
  from?: string
  to: string
  /** The last Transaction of the previous page; the page starts after it. */
  after?: { date: string; id: number }
  limit: number
}

/** The validated query as a LoansQuery: the Category read as a number, and the page's cursor and size read as the other Reports' pages are, with this Report's page size. */
export const toLoansQuery = (q: z.output<typeof loansQuery>): LoansQuery => ({ categoryId: Number(q.categoryId), from: q.from, to: q.to, ...toPaging(q, LOANS_PAGE_SIZE) })

/** One Transaction of a loan. Money out is negative, as in every list. */
export type LoanRow = { id: number; date: string; description: string; amountCents: number; accountName: string; note: string | null }

export type LoanPage = {
  category: { id: number; name: string }
  /**
   * On the first page only (null on a page that continues after another): what the Category held before `from`. `cents` is the sum of its Transactions then, in the
   * Transactions' own sign (money in is positive), so a person who was lent $500.00 and has paid back none is -50000; `count` is how many Transactions that is, so a loan
   * that was never used can be told from one that was paid off. Both are zero when there is no `from`. The Report turns the sum, and every balance after it, into what is
   * owed (src/lib/report-loans.ts).
   */
  opening: { cents: number; count: number } | null
  transactions: LoanRow[]
  next: string | null
}

/**
 * The part of a statement that picks one Category's loans: its Transactions are found through the Category's indexes, and the effective Category and kind
 * are then checked on those alone (an Override can outrank a Rule's Category, and a Transfer is not in one), with `isLoan` the only word on what a loan is.
 * `category.joins` must follow `transactions t` in the statement.
 */
function loansOf(id: number) {
  const category = effectiveCategory()
  const candidates = categoryCandidates(id)
  const binds: (string | number)[] = [...candidates.binds, id]
  return { category, sql: `${candidates.sql} AND ${category.shown.id} = ? AND ${isLoan(category)}`, binds }
}

/** The statement for one page of a loan: the Category's Transactions in the dates, oldest first, and one more than the page holds, to tell whether there is another (`pageOf`). */
export function buildLoanPage(query: LoansQuery): Statement {
  const { category, sql, binds } = loansOf(query.categoryId)
  const conditions = [sql, 't.date <= ?']
  binds.push(query.to)
  if (query.from !== undefined) {
    conditions.push('t.date >= ?')
    binds.push(query.from)
  }
  if (query.after) {
    conditions.push('(t.date, t.id) > (?, ?)')
    binds.push(query.after.date, query.after.id)
  }
  binds.push(query.limit + 1)
  return {
    sql: `SELECT t.id, t.date, t.description, t.amount_cents AS amountCents, a.name AS accountName, t.note
          FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
          WHERE ${conditions.join(' AND ')}
          ORDER BY t.date, t.id
          LIMIT ?`,
    binds,
  }
}

/** The statement for what the Category's Transactions before `from` add up to (money in less money out, so it is below zero while more has gone out than come back), and how many they are. */
export function buildLoanOpening(categoryId: number, from: string): Statement {
  const { category, sql, binds } = loansOf(categoryId)
  return {
    sql: `SELECT COALESCE(SUM(t.amount_cents), 0) AS cents, COUNT(*) AS count FROM transactions t ${category.joins} WHERE ${sql} AND t.date < ?`,
    binds: [...binds, from],
  }
}

/**
 * A page of the Report. Null when there is no such Loans Category: none with that ID, one that was removed, or one whose kind is not Loans, so a Spending
 * Category is never listed as a loan and a loan that owes nothing is not mistaken for a Category that does not exist.
 * Cost: one D1 query to check the Category, one for the page, and one more for the opening balance on the first page of a loan that has a start date.
 */
export async function readLoanPage(db: D1Database, query: LoansQuery): Promise<LoanPage | null> {
  const category = await findCategory(db, query.categoryId)
  if (!category || !isLoansKind(category.kind)) return null
  let opening: LoanPage['opening'] = null
  if (query.after === undefined) {
    opening = { cents: 0, count: 0 }
    if (query.from !== undefined) {
      const { sql, binds } = buildLoanOpening(query.categoryId, query.from)
      opening = (await db.prepare(sql).bind(...binds).first<{ cents: number; count: number }>()) ?? opening
    }
  }
  const { sql, binds } = buildLoanPage(query)
  const { results } = await db.prepare(sql).bind(...binds).all<LoanRow>()
  return { category: { id: category.id, name: category.name }, opening, ...pageOf(results, query.limit) }
}
