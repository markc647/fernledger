import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { TransactionList } from '@/components/transaction-list'
import { meQuery } from '@/lib/me'
import type { TransactionSearch } from '@/lib/transaction-search'

export const Route = createFileRoute('/uncategorised')({
  component: Uncategorised,
  staticData: { nav: { label: 'Uncategorised', adminOnly: true, order: 15 } },
})

function Uncategorised() {
  const { data: me } = useQuery(meQuery)
  // Only the order and the page change here; the list is always the Transactions with no Category.
  const [search, setSearch] = useState<TransactionSearch>({ category: 'uncategorised' })
  const onSearch = useCallback((next: TransactionSearch) => setSearch({ ...next, category: 'uncategorised' }), [])
  // Hiding the navigation is a courtesy; the API serves the same list to every Member, and refuses a Member's write.
  if (!me) return null
  return (
    <>
      <h1 className="text-2xl font-semibold">Uncategorised</h1>
      {me.role === 'admin' ? (
        <TransactionList
          search={search}
          onSearch={onSearch}
          intro={<p className="mt-2">Transactions with no Category. Edit one to set an Override; it leaves this list once it has a Category.</p>}
          emptyMessage="There are no Uncategorised Transactions."
        />
      ) : (
        <p className="mt-2">Only the Admin can use this list. Every Member can see each Transaction's Category on the Transactions page.</p>
      )}
    </>
  )
}
