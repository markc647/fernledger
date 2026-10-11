import * as z from 'zod/mini'
import { isQueryDate } from './dates'
import { monthEnd, monthsBefore, monthStart, nzMonth } from './months'

// The question the spending chart asks (GET /api/charts/spending): which dates. The answer is spending-by-category.ts's, the same one a Report of it
// gets (ADR 0012), so this file is only the periods the Worker names and the query string that asks for them or for two dates.

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
