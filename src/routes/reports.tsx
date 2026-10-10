import { createFileRoute } from '@tanstack/react-router'
import { BalancesForm, TransactionListingForm } from '@/components/report-form'

export const Route = createFileRoute('/reports')({
  component: Reports,
  staticData: { nav: { label: 'Reports', order: 50 } },
})

/**
 * Where a Member opens a Report. Each opens in a new window as a page laid out for paper, which the browser prints or saves as
 * a PDF; nothing is made on the server. Every Member can open every Report.
 */
function Reports() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="mt-2">A Report opens in a new window, laid out for paper. Print it from there, or save it as a PDF.</p>
      <section aria-labelledby="transaction-listing" className="mt-6">
        <h2 id="transaction-listing" className="text-xl font-semibold">
          Transaction listing
        </h2>
        <p className="mt-2">Every Transaction in the dates you choose, with its Category and Note, Account by Account, oldest first.</p>
        <div className="mt-4">
          <TransactionListingForm />
        </div>
      </section>
      <section aria-labelledby="balances-over-time" className="mt-8">
        <h2 id="balances-over-time" className="text-xl font-semibold">
          Balances over time
        </h2>
        <p className="mt-2">Each Account's balance at the end of every month in the dates you choose, with the balance when they begin and when they end, and any Balance Check differences.</p>
        <div className="mt-4">
          <BalancesForm />
        </div>
      </section>
    </>
  )
}
