import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { formatDate } from '@/lib/format'
import { recentTransactionsQuery } from '@/lib/queries'

/** Summary widget: the newest few Transactions across every Account. */
export function RecentTransactionsWidget() {
  const { data, error } = useQuery(recentTransactionsQuery)
  return (
    <section aria-labelledby="recent-heading">
      <h2 id="recent-heading" className="mb-3 text-xl font-semibold">
        Recent transactions
      </h2>
      {error ? (
        <p role="alert">Fernledger couldn't load the recent Transactions. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <ResponsiveTable
            caption="The newest Transactions"
            rows={data.transactions}
            getRowKey={(row) => row.id}
            emptyMessage="There are no Transactions yet."
            columns={[
              { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
              { key: 'account', header: 'Account', cell: (row) => row.accountName },
              { key: 'description', header: 'Description', cell: (row) => row.description },
              { key: 'amount', header: 'Amount', align: 'end', cell: (row) => <Amount cents={row.amountCents} showLabel /> },
            ]}
          />
          {data.transactions.length > 0 && (
            <p className="mt-3">
              <Link to="/transactions" className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                See all transactions
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  )
}
