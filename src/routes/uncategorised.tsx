import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { TransactionList } from '@/components/transaction-list'
import { meQuery } from '@/lib/me'
import { parseTransactionSearch, tidy, type TransactionSearch } from '@/lib/transaction-search'

// Only the order and the page are in the address (?sort=amount&page=2): the list is always the Transactions with no Category.
// Keeping them there lets "Back to Uncategorised" from a Transaction's details return to the same page of the list.
export const Route = createFileRoute('/uncategorised')({
  component: Uncategorised,
  validateSearch: (raw: Record<string, unknown>) => {
    const { sort, dir, page } = parseTransactionSearch(raw)
    return { sort, dir, page }
  },
  staticData: { nav: { label: 'Uncategorised', adminOnly: true, order: 15 } },
})

function Uncategorised() {
  const { data: me } = useQuery(meQuery)
  const { sort, dir, page } = Route.useSearch()
  const navigate = Route.useNavigate()
  const search = useMemo<TransactionSearch>(() => tidy({ category: 'uncategorised', sort, dir, page }), [sort, dir, page])
  const onSearch = useCallback(
    (next: TransactionSearch, options?: { replace?: boolean }) => void navigate({ search: { sort: next.sort, dir: next.dir, page: next.page }, replace: options?.replace }),
    [navigate],
  )
  // Hiding the navigation is a courtesy; the API serves the same list to every Member, and refuses a Member's write.
  if (!me) return null
  return (
    <>
      <h1 className="text-2xl font-semibold">Uncategorised</h1>
      {me.role === 'admin' ? (
        <TransactionList
          search={search}
          onSearch={onSearch}
          origin="uncategorised"
          intro={<p className="mt-2">Transactions with no Category. Edit one to set an Override; it leaves this list once it has a Category.</p>}
          emptyMessage="There are no Uncategorised Transactions."
        />
      ) : (
        <p className="mt-2">Only the Admin can use this list. Every Member can see each Transaction's Category on the Transactions page.</p>
      )}
    </>
  )
}
