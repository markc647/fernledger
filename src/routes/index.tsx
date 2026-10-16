import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SummaryCards } from '@/components/summary/summary-cards'
import { meQuery } from '@/lib/me'

export const Route = createFileRoute('/')({
  component: Landing,
  staticData: { nav: { label: 'Summary', adminLabel: 'Dashboard', order: 0 } },
})

/**
 * Where everyone lands: the Admin on the Dashboard, every Member on the Summary. They are the same cards (src/components/summary/summary-cards.tsx) under a different heading, and
 * neither says who is signed in, because the sidebar's footer does.
 */
function Landing() {
  const { data: me } = useQuery(meQuery)
  // Until we know who is signed in, neither page: the Admin never sees the Summary flash up and be replaced.
  if (!me) return <p role="status">Loading…</p>
  return (
    <>
      <h1 className="text-2xl font-semibold">{me.role === 'admin' ? 'Dashboard' : 'Summary'}</h1>
      <SummaryCards />
    </>
  )
}
