import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { TransactionList } from '@/components/transaction-list'
import { meQuery } from '@/lib/me'
import { parseTransactionSearch, type TransactionSearch } from '@/lib/transaction-search'

// The search lives in the address (?account=2&q=cafe&sort=amount&page=3), so it survives a reload and Back returns to it.
export const Route = createFileRoute('/transactions')({
  component: Transactions,
  validateSearch: parseTransactionSearch,
  staticData: { nav: { label: 'Transactions', order: 10 } },
})

function Transactions() {
  const { data: me } = useQuery(meQuery)
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: TransactionSearch, options?: { replace?: boolean }) => void navigate({ search: next, replace: options?.replace }), [navigate])

  return (
    <>
      <h1 className="text-2xl font-semibold">Transactions</h1>
      <p className="mt-2">Search and filter every Transaction, and open one to see all of its details.</p>
      {/* The Report lists the whole Account and dates, whatever the other filters say, so it carries only those. It is a page for paper, so it opens in a new window. */}
      <p className="mt-2">
        {search.from && search.to ? (
          <>
            <Link
              to="/reports/transactions"
              search={{ account: search.account, from: search.from, to: search.to }}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-4"
            >
              Open a Transaction listing Report for these dates (opens in a new window)
            </Link>
            . It lists every Transaction in the Account and dates, whatever the other filters say.
          </>
        ) : (
          <>
            To print Transactions as a Report, set a From and To date and search, or <Link to="/reports" className="underline underline-offset-4">choose dates on the Reports page</Link>.
          </>
        )}
      </p>
      <TransactionList
        search={search}
        onSearch={onSearch}
        showFilters
        emptyMessage={
          <>
            There are no Transactions yet.{' '}
            {me?.role === 'admin' && (
              <>
                <Link to="/import" className="underline underline-offset-4">Import a bank file</Link> to add some.
              </>
            )}
          </>
        }
      />
    </>
  )
}
