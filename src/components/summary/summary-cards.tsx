import { HelpHeading } from '@/components/help-sheet'
import { BALANCES_ABOUT, BalancesWidget } from '@/components/summary/balances-widget'
import { BUDGET_ABOUT, BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
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

/**
 * The text of the cards, for the page's "?" (the cards keep their tables and not their explanations): a part for each card that has any, in the order the cards are. A new card with
 * something to explain adds its part here.
 */
export function SummaryHelp() {
  return (
    <>
      <HelpHeading>Balances</HelpHeading>
      <p>{BALANCES_ABOUT}</p>
      <HelpHeading>Budget vs actual</HelpHeading>
      <p>{BUDGET_ABOUT}</p>
    </>
  )
}
