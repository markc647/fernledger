import * as z from 'zod/mini'
import { isQueryDate, isRealDate } from './dates'
import { effectiveCategory } from './effective-category'
import type { Statement } from './transaction-search'

// The data of the Transaction listing Report (GET /api/reports/transactions), as pure functions. One Account at a time, oldest
// first, a page at a time: ADR 0004 gives a request 10 ms of CPU, so a Report of thousands of Transactions is read as pages of
// about the size an Import chunk is (500), which the Report page puts together. A page continues after the last Transaction
// of the one before (a keyset on date and ID), never from an offset, so a page deep in the history reads no more than the first.

/** The most Transactions in a page, and the size of one when the request doesn't say. The Report page keeps its own copy (src/lib/report-transactions.ts). */
export const REPORT_PAGE_SIZE = 500

const digits = z.string().check(z.regex(/^\d{1,9}$/))
/** Where the next page starts: the date and ID of the last Transaction of this one, `2026-10-02:123`. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}):([1-9]\d{0,14})$/

/** The query string of a Report page, validated before anything runs. A refusal names the field. */
export const reportQuery = z
  .object({
    accountId: z.string().check(z.regex(/^[1-9]\d{0,8}$/)),
    from: z.string().check(z.refine(isQueryDate)),
    to: z.string().check(z.refine(isQueryDate)),
    after: z.optional(z.string().check(z.regex(CURSOR), z.refine((cursor) => isRealDate(cursor.slice(0, 10))))),
    limit: z.optional(digits),
  })
  .check(z.refine((q) => q.from <= q.to, { path: ['to'] }))

export type ReportQueryParams = z.output<typeof reportQuery>

export type ReportQuery = {
  accountId: number
  /** NZ dates, both ends included. */
  from: string
  to: string
  /** The last Transaction of the previous page; the page starts after it. */
  after?: { date: string; id: number }
  limit: number
}

/** The validated query as a ReportQuery: the page size defaulted and kept between one and `REPORT_PAGE_SIZE`. */
export function toReportQuery(q: ReportQueryParams): ReportQuery {
  const cursor = q.after === undefined ? null : CURSOR.exec(q.after)
  return {
    accountId: Number(q.accountId),
    from: q.from,
    to: q.to,
    after: cursor ? { date: cursor[1]!, id: Number(cursor[2]) } : undefined,
    limit: Math.min(Math.max(Number(q.limit ?? REPORT_PAGE_SIZE), 1), REPORT_PAGE_SIZE),
  }
}

/**
 * The statement for one page: the Account's Transactions in the range, oldest first, from the (account_id, date, id) index
 * (migration 1002), so it reads about `limit` rows however far in it starts. It asks for one more than the page holds, to
 * tell whether there is another page (`pageOf`). A Transaction's Category is its effective Category (effective-category.ts),
 * the one the Transactions list shows.
 */
export function buildReportPage(query: ReportQuery): Statement {
  const category = effectiveCategory()
  // SQLite uses an index for a plain range on the date, not for a (date, id) row comparison, so the page starts at the
  // cursor's date and the comparison only passes over the Transactions on that date that the last page already gave.
  const start = query.after && query.after.date > query.from ? query.after.date : query.from
  const binds: (string | number)[] = [query.accountId, start, query.to]
  let after = ''
  if (query.after) {
    after = 'AND (t.date, t.id) > (?, ?)'
    binds.push(query.after.date, query.after.id)
  }
  binds.push(query.limit + 1)
  return {
    sql: `SELECT t.id, t.date, t.description, t.amount_cents AS amountCents, ${category.name} AS categoryName, t.note
          FROM transactions t ${category.joins}
          WHERE t.account_id = ? AND t.date >= ? AND t.date <= ? ${after}
          ORDER BY t.date, t.id
          LIMIT ?`,
    binds,
  }
}

export type ReportRow = { id: number; date: string; description: string; amountCents: number; categoryName: string | null; note: string | null }

/** The rows `buildReportPage` read as a page: the first `limit` of them, and where the next page starts if there were more. */
export function pageOf(rows: ReportRow[], limit: number): { transactions: ReportRow[]; next: string | null } {
  const transactions = rows.slice(0, limit)
  const last = transactions.at(-1)
  return { transactions, next: rows.length > limit && last ? `${last.date}:${last.id}` : null }
}
