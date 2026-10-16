import { BalancesWidget } from '@/components/summary/balances-widget'
import { BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
import { SummaryGrid } from '@/components/summary/dashboard-card'
import { RecentTransactionsWidget } from '@/components/summary/recent-transactions-widget'

/**
 * Everything the Summary shows, as a grid of cards, in the order it is read: how the Accounts stand (with whether each agrees with the bank, and whether Sync reached it), this month
 * against Budget, and the newest Transactions. The Member's Summary and the Admin's Dashboard are both this and nothing more, so they cannot disagree; the pages add only their heading.
 * The charts are not here: each reads every Transaction it covers, so each has a page where it waits to be asked for (ADR 0004).
 */
export function SummaryCards() {
  return (
    <SummaryGrid>
      <BalancesWidget />
      <BudgetVsActualWidget />
      <RecentTransactionsWidget />
    </SummaryGrid>
  )
}
