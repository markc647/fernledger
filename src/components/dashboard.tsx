import { Link } from '@tanstack/react-router'
import { DashboardCard } from '@/components/summary/dashboard-card'
import { SummaryCards } from '@/components/summary/summary-cards'
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
 * Where the Admin lands: a card of the shortcuts to the work only the Admin does, then every card the Summary shows every Member (`SummaryCards`, so the two cannot disagree),
 * of which the two charts each wait for a button, because working them out reads every Transaction (ADR 0004). A Member lands on the Summary, which has all of these but the tools.
 */
export function Dashboard({ me }: { me: { email: string; role: Role } }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2">
        Signed in as {me.email} ({roleLabel(me.role)}).
      </p>
      <SummaryCards>
        <DashboardCard headingId="tools-heading" title="Your tools">
          <ul className="grid gap-3 @2xl/summary:grid-cols-2 @4xl/summary:grid-cols-3">
            {TOOLS.map((tool) => (
              <li key={tool.to}>
                <Link
                  to={tool.to}
                  className="block h-full min-h-11 rounded-lg border p-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="block font-semibold underline underline-offset-4">{tool.name}</span>
                  <span className="mt-1 block text-muted-foreground">{tool.about}</span>
                </Link>
              </li>
            ))}
          </ul>
        </DashboardCard>
      </SummaryCards>
    </>
  )
}
