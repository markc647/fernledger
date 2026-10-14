import type { ReactNode } from 'react'
import { LazyCharts } from '@/components/charts/lazy-charts'
import { BalanceWarningsWidget } from '@/components/summary/balance-warnings-widget'
import { BalancesWidget } from '@/components/summary/balances-widget'
import { BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
import { SummaryGrid } from '@/components/summary/dashboard-card'
import { RecentTransactionsWidget } from '@/components/summary/recent-transactions-widget'

/**
 * Everything the Summary shows, as a grid of cards, in the order it is read: anything that needs a second look first (Balance checks), how the Accounts stand, this month against
 * Budget, the newest Transactions, and last the charts, which read the most and so each wait for a button. The Member's Summary and the Admin's Dashboard are both this, so they
 * cannot disagree; the Dashboard puts its own cards (`children`) before them.
 */
export function SummaryCards({ children }: { children?: ReactNode }) {
  return (
    <SummaryGrid>
      {children}
      <BalanceWarningsWidget />
      <BalancesWidget />
      <BudgetVsActualWidget />
      <RecentTransactionsWidget />
      <LazyCharts />
    </SummaryGrid>
  )
}
