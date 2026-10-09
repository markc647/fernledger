import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { TransactionList } from '@/components/transaction-list'
import { meQuery } from '@/lib/me'

export const Route = createFileRoute('/transactions')({
  component: Transactions,
  staticData: { nav: { label: 'Transactions', order: 10 } },
})

function Transactions() {
  const { data: me } = useQuery(meQuery)

  return (
    <>
      <h1 className="text-2xl font-semibold">Transactions</h1>
      <TransactionList
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
