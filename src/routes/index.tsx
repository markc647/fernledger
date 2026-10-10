import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BalanceWarningsWidget } from '@/components/summary/balance-warnings-widget'
import { BalancesWidget } from '@/components/summary/balances-widget'
import { BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
import { RecentTransactionsWidget } from '@/components/summary/recent-transactions-widget'
import { meQuery } from '@/lib/me'
import { roleLabel } from '@/lib/role'

export const Route = createFileRoute('/')({
  component: Summary,
  staticData: { nav: { label: 'Summary', order: 0 } },
})

/** Where every Member lands: how the Accounts stand, what has just happened, and anything that needs a second look. Each part is its own widget. */
function Summary() {
  const { data: me } = useQuery(meQuery)
  return (
    <>
      <h1 className="text-2xl font-semibold">Summary</h1>
      {me && (
        <p className="mt-2">
          Signed in as {me.email} ({roleLabel(me.role)}).
        </p>
      )}
      <div className="mt-6 grid gap-8">
        <BalanceWarningsWidget />
        <BalancesWidget />
        <BudgetVsActualWidget />
        <RecentTransactionsWidget />
      </div>
    </>
  )
}
