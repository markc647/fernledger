import { createFileRoute } from '@tanstack/react-router'
import { BalancesForm, BudgetVsActualForm, IncomeVsSpendingForm, SpendingForm, TransactionListingForm } from '@/components/report-form'
import { NOT_COUNTED_AS_SPENDING_OR_INCOME } from '@/lib/budgets'

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
      <section aria-labelledby="spending-by-category" className="mt-6">
        <h2 id="spending-by-category" className="text-xl font-semibold">
          Spending by Category
        </h2>
        <p className="mt-2">What each Category spent in the dates you choose, the most spent first, with the total. Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted.</p>
        <div className="mt-4">
          <SpendingForm />
        </div>
      </section>
      <section aria-labelledby="income-vs-spending" className="mt-8">
        <h2 id="income-vs-spending" className="text-xl font-semibold">
          Income vs spending by month
        </h2>
        <p className="mt-2">What came in and what was spent in each month of the dates you choose, with the difference and the totals. {NOT_COUNTED_AS_SPENDING_OR_INCOME}</p>
        <div className="mt-4">
          <IncomeVsSpendingForm />
        </div>
      </section>
      <section aria-labelledby="transaction-listing" className="mt-8">
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
      <section aria-labelledby="budget-vs-actual" className="mt-8">
        <h2 id="budget-vs-actual" className="text-xl font-semibold">
          Budget vs actual
        </h2>
        <p className="mt-2">Each Category's Budget against what it spent, month by month, for the months your dates touch, with the months that have ended added together.</p>
        <div className="mt-4">
          <BudgetVsActualForm />
        </div>
      </section>
    </>
  )
}
