import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Dashboard } from '@/components/dashboard'
import { SummaryCards } from '@/components/summary/summary-cards'
import { meQuery } from '@/lib/me'
import { roleLabel, type Role } from '@/lib/role'

export const Route = createFileRoute('/')({
  component: Landing,
  staticData: { nav: { label: 'Summary', adminLabel: 'Dashboard', order: 0 } },
})

/** Where everyone lands: the Admin on the Dashboard, every Member on the Summary. Both are the same cards (src/components/summary/summary-cards.tsx). */
function Landing() {
  const { data: me } = useQuery(meQuery)
  // Until we know who is signed in, neither page: the Admin never sees the Summary flash up and be replaced.
  if (!me) return <p role="status">Loading…</p>
  return me.role === 'admin' ? <Dashboard me={me} /> : <Summary me={me} />
}

/** Where every Member lands: how the Accounts stand, what has just happened, anything that needs a second look, and the charts. Each part is its own card. */
function Summary({ me }: { me: { email: string; role: Role } }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Summary</h1>
      <p className="mt-2">
        Signed in as {me.email} ({roleLabel(me.role)}).
      </p>
      <SummaryCards />
    </>
  )
}
