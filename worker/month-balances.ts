import { nextMonth } from './months'

/**
 * An Account's balance at the end of each month from `startMonth` to `endMonth` (both `YYYY-MM`, both included), oldest first, from the last
 * balance its balance history has in each month (`atMonthEnd`, picked out by `REPORT_HISTORY`). A month with no Transactions has none, and
 * carries the balance before it, so quiet months repeat the balance; the first month with none carries `opening`.
 *
 * The one rule for carrying balances across months: the balances Report (`report-balances.ts`) and net worth (`net-worth.ts`) both build their months
 * with it, so a quiet month cannot mean one thing in one and another in the other.
 */
export function carryForward(atMonthEnd: ReadonlyMap<string, number>, startMonth: string, endMonth: string, opening: number): number[] {
  const balances: number[] = []
  let previous = opening
  for (let month = startMonth; month <= endMonth; month = nextMonth(month)) {
    previous = atMonthEnd.get(month) ?? previous
    balances.push(previous)
  }
  return balances
}
