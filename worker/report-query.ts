import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { ID } from './validate'

// What every Report's query string starts with: the Account and the dates, both ends included. Each Report's own query adds what it
// needs (the Transaction listing a cursor and a page size) and ends with `datesInOrder`, so they all validate, and refuse, alike.

/** The fields of a Report's query string: an Account's ID (a whole number from 1, at most fifteen digits) and two real dates in the years a search accepts. */
export const reportRange = {
  accountId: z.string().check(z.regex(ID)),
  from: z.string().check(z.refine(isQueryDate)),
  to: z.string().check(z.refine(isQueryDate)),
}

/** For a Report that can cover every Account in one request (spending by Category): the same fields with the Account left out for all of them. */
export const reportRangeOfAll = { ...reportRange, accountId: z.optional(reportRange.accountId) }

/** The last check of a Report's query: `from` is not after `to`. A refusal names `to`. */
export const datesInOrder = z.refine<{ from: string; to: string }>((q) => q.from <= q.to, { path: ['to'] })
