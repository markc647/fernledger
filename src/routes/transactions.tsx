import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatDate, formatSignedNzd } from '@/lib/format'
import { meQuery } from '@/lib/me'
import { PAGE_SIZE, transactionsQuery } from '@/lib/queries'

export const Route = createFileRoute('/transactions')({
  component: Transactions,
  staticData: { nav: { label: 'Transactions', order: 10 } },
})

function Transactions() {
  const [page, setPage] = useState(0)
  const { data, error } = useQuery({ ...transactionsQuery(page), placeholderData: keepPreviousData })
  const { data: me } = useQuery(meQuery)

  return (
    <>
      <h1 className="text-2xl font-semibold">Transactions</h1>
      {error ? (
        <p role="alert" className="mt-2">Fernledger couldn't load the Transactions. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status" className="mt-2">Loading…</p>
      ) : data.total === 0 ? (
        <p className="mt-2">
          There are no Transactions yet.{' '}
          {me?.role === 'admin' && (
            <>
              <Link to="/import" className="underline underline-offset-4">Import a bank file</Link> to add some.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto" role="region" aria-label="Transactions table" tabIndex={0}>
            <table className="w-full text-left">
              <caption className="sr-only">Transactions, newest first</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-2 pe-4 font-medium">Date</th>
                  <th scope="col" className="py-2 pe-4 font-medium">Account</th>
                  <th scope="col" className="py-2 pe-4 font-medium">Description</th>
                  <th scope="col" className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="py-2 pe-4 whitespace-nowrap">{formatDate(t.date)}</td>
                    <td className="py-2 pe-4">{t.accountName}</td>
                    <td className="py-2 pe-4">{t.description}</td>
                    <td className={`py-2 text-right whitespace-nowrap tabular-nums ${t.amountCents > 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}`}>
                      <span className="sr-only">{t.amountCents > 0 ? 'Money in ' : t.amountCents < 0 ? 'Money out ' : ''}</span>
                      {formatSignedNzd(t.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="touch" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Newer
            </Button>
            <Button size="touch" variant="outline" disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>
              Older
            </Button>
            <span aria-live="polite">
              Showing {page * PAGE_SIZE + 1} to {Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
            </span>
          </nav>
        </>
      )}
    </>
  )
}
