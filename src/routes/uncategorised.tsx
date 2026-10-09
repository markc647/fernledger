import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TransactionList } from '@/components/transaction-list'
import { meQuery } from '@/lib/me'

export const Route = createFileRoute('/uncategorised')({
  component: Uncategorised,
  staticData: { nav: { label: 'Uncategorised', adminOnly: true, order: 15 } },
})

function Uncategorised() {
  const { data: me } = useQuery(meQuery)
  // Hiding the navigation is a courtesy; the API serves the same list to every Member, and refuses a Member's write.
  if (!me) return null
  return (
    <>
      <h1 className="text-2xl font-semibold">Uncategorised</h1>
      {me.role === 'admin' ? (
        <TransactionList
          uncategorised
          intro={<p className="mt-2">Transactions with no Category. Edit one to set an Override; it leaves this list once it has a Category.</p>}
          emptyMessage="There are no Uncategorised Transactions."
        />
      ) : (
        <p className="mt-2">Only the Admin can use this list. Every Member can see each Transaction's Category on the Transactions page.</p>
      )}
    </>
  )
}
