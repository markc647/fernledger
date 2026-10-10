import { Link } from '@tanstack/react-router'
import { LazyCharts } from '@/components/charts/lazy-charts'
import { BalanceWarningsWidget } from '@/components/summary/balance-warnings-widget'
import { BalancesWidget } from '@/components/summary/balances-widget'
import { BudgetVsActualWidget } from '@/components/summary/budget-vs-actual-widget'
import { RecentTransactionsWidget } from '@/components/summary/recent-transactions-widget'
import { roleLabel, type Role } from '@/lib/role'

// The Admin's tools, in the order the work usually goes: bring Transactions in, give them Categories, and set what they may spend.
const TOOLS = [
  { to: '/import', name: 'Import', about: 'Add Transactions from a bank file, or replace an Account’s imported history.' },
  { to: '/uncategorised', name: 'Uncategorised', about: 'Give Transactions a Category.' },
  { to: '/rules', name: 'Rules', about: 'Categorise Transactions automatically, and apply the Rules to the ones you already have.' },
  { to: '/categories', name: 'Categories', about: 'Add, rename or remove Categories, and say what each is for.' },
  { to: '/budgets', name: 'Budgets', about: 'Set what each Spending Category may spend a month.' },
  { to: '/settings', name: 'Settings', about: 'The title, each Account’s Cutover Date, and the About your data page.' },
] as const

/**
 * Where the Admin lands: the shortcuts to the work only the Admin does, then everything the Summary shows every Member (it is the same widgets, so the
 * two cannot disagree), then the charts. A Member lands on the Summary, which has the charts one click away.
 */
export function Dashboard({ me }: { me: { email: string; role: Role } }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2">
        Signed in as {me.email} ({roleLabel(me.role)}).
      </p>
      <div className="mt-6 grid gap-8">
        <section aria-labelledby="tools-heading">
          <h2 id="tools-heading" className="mb-3 text-xl font-semibold">
            Your tools
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <li key={tool.to}>
                <Link
                  to={tool.to}
                  className="block min-h-11 rounded-xl border bg-card p-4 text-card-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="block font-semibold underline underline-offset-4">{tool.name}</span>
                  <span className="mt-1 block text-muted-foreground">{tool.about}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <BalanceWarningsWidget />
        <BalancesWidget />
        <BudgetVsActualWidget />
        <RecentTransactionsWidget />
        <LazyCharts />
      </div>
    </>
  )
}
