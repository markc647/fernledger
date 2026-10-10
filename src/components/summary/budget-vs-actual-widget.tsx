import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ResponsiveTable } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { budgetStatus, spentLine } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { meQuery } from '@/lib/me'
import { budgetVsActualQuery } from '@/lib/queries'

const money = 'whitespace-nowrap tabular-nums [font-kerning:none]'

/** Summary widget: this month's Budget for each Category that has one, against what it has spent, and whether it is over or under. */
export function BudgetVsActualWidget() {
  const { data, error } = useQuery(budgetVsActualQuery)
  const { data: me } = useQuery(meQuery)
  return (
    <section aria-labelledby="budget-heading">
      <h2 id="budget-heading" className="mb-3 text-xl font-semibold">
        Budget vs actual
      </h2>
      {error ? (
        <p role="alert">Fernledger couldn't load the Budgets. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <p className="mb-3 text-muted-foreground">
            {formatMonth(data.month)}. Each month stands alone: a Budget you don't spend isn't carried over. Transfers between your own Accounts and Pending Transactions aren't counted as spending.
          </p>
          <ResponsiveTable
            caption={`Budget and spending in ${formatMonth(data.month)} for each Category with a Budget`}
            rows={data.rows}
            getRowKey={(row) => row.categoryId}
            emptyMessage={`No Category has a Budget in ${formatMonth(data.month)}.${me?.role === 'admin' ? ' Set one on the Budgets page.' : ''}`}
            columns={[
              { key: 'category', header: 'Category', cell: (row) => row.categoryName },
              { key: 'budget', header: 'Budget', align: 'end', cell: (row) => <span className={money}>{formatBalance(row.budgetCents)}</span> },
              { key: 'spent', header: 'Spent', align: 'end', cell: (row) => <span className={money}>{spentLine(row.spentCents)}</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (row) => {
                  const status = budgetStatus(row.budgetCents, row.spentCents)
                  return (
                    <span className="inline-flex flex-col items-start">
                      <Status tone={status.tone}>{status.words}</Status>
                      <span className="text-muted-foreground tabular-nums">{status.detail}</span>
                    </span>
                  )
                },
              },
            ]}
          />
          <p className="mt-3">
            <Link to="/budgets" className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {me?.role === 'admin' ? 'Set or change Budgets' : 'See all Budgets'}
            </Link>
          </p>
        </>
      )}
    </section>
  )
}
