import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Dashboard } from '@/components/dashboard'
import { BalanceWarningsWidget } from '@/components/summary/balance-warnings-widget'
import { BalancesWidget } from '@/components/summary/balances-widget'
import { BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
import { RecentTransactionsWidget } from '@/components/summary/recent-transactions-widget'
import { meQuery } from '@/lib/me'
import { roleLabel, type Role } from '@/lib/role'

export const Route = createFileRoute('/')({
  component: Landing,
  staticData: { nav: { label: 'Summary', adminLabel: 'Dashboard', order: 0 } },
})

/** Where everyone lands: the Admin on the Dashboard, every Member on the Summary. Both are built from the same widgets (src/components/summary). */
function Landing() {
  const { data: me } = useQuery(meQuery)
  // Until we know who is signed in, neither page: the Admin never sees the Summary flash up and be replaced.
  if (!me) return <p role="status">Loading…</p>
  return me.role === 'admin' ? <Dashboard me={me} /> : <Summary me={me} />
}

/** Where every Member lands: how the Accounts stand, what has just happened, and anything that needs a second look. Each part is its own widget. */
function Summary({ me }: { me: { email: string; role: Role } }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Summary</h1>
      <p className="mt-2">
        Signed in as {me.email} ({roleLabel(me.role)}).
      </p>
      <div className="mt-6 grid gap-8">
        <BalanceWarningsWidget />
        <BalancesWidget />
        <BudgetVsActualWidget />
        <RecentTransactionsWidget />
        <section aria-labelledby="charts-heading">
          <h2 id="charts-heading" className="mb-3 text-xl font-semibold">
            Charts
          </h2>
          <p className="text-muted-foreground">How net worth has changed over time, and where the money has gone.</p>
          <p className="mt-3">
            <Link to="/charts" className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              See the charts
            </Link>
          </p>
        </section>
      </div>
    </>
  )
}
