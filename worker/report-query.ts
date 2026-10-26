import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { monthCount } from './months'
import { ID } from './validate'

// What every Report's query string starts with: the Account and the dates, both ends included. Each Report's own query adds what it
// needs (the Transaction listing a cursor and a page size) and ends with `datesInOrder`, so they all validate, and refuse, alike.

/** The dates of a Report's query string: two real dates in the years a search accepts. A Report of all Accounts together (Budget vs actual) takes these alone. */
export const reportDates = {
  from: z.string().check(z.refine(isQueryDate)),
  to: z.string().check(z.refine(isQueryDate)),
}

/** An ID in a Report's query string, an Account's or (for the Loans Report) a Category's: a whole number from 1, at most fifteen digits. */
export const reportId = z.string().check(z.regex(ID))

/** The fields of a Report's query string: an Account's ID and the dates. */
export const reportRange = {
  accountId: reportId,
  ...reportDates,
}

/** For a Report that can cover every Account in one request (Spending by Category, Income vs spending by month): the same fields with the Account left out for all of them. */
export const reportRangeOfAll = { accountId: z.optional(reportRange.accountId), ...reportDates }

/** The last check of a Report's query: `from` is not after `to`. A refusal names `to`. */
export const datesInOrder = z.refine<{ from: string; to: string }>((q) => q.from <= q.to, { path: ['to'] })

/** A Report's dates span at most `max` NZ months, counting both ends' months. Dates left out (a named period) pass. A refusal names `to`. */
export const monthsAtMost = (max: number) =>
  z.refine<{ from?: string; to?: string }>((q) => q.from === undefined || q.to === undefined || monthCount(q.from.slice(0, 7), q.to.slice(0, 7)) <= max, { path: ['to'] })

const ACCOUNT_EXISTS = 'SELECT id FROM accounts WHERE id = ?'

/**
 * Whether a Report that was asked about one Account (`accountId` set) must be a 404: that Account does not exist, so the Report is not mistaken for an Account that
 * had nothing in the dates. One D1 query, and none when the Report is for every Account.
 */
export const accountMissing = async (db: D1Database, { accountId }: { accountId?: number }) => accountId !== undefined && !(await db.prepare(ACCOUNT_EXISTS).bind(accountId).first())
