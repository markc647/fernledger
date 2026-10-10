import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ResponsiveTable } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { budgetStatus, spentText } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { meQuery } from '@/lib/me'
import { budgetVsActualQuery } from '@/lib/queries'

const money = 'whitespace-nowrap tabular-nums [font-kerning:none]'

/** A Category with a Budget, or a row for what has none: Spending Categories without a Budget, and Uncategorised. */
type Row = { key: string; name: string; budgetCents: number | null; spentCents: number }

/**
 * Summary widget: this month's Budget for each Spending Category that has one, against what it spent, and whether it is over or under,
 * then what the rest spent, and Uncategorised on its own. Which Budget a month has and what was spent come from the Worker (ADR 0012); the browser only words how they compare.
 */
export function BudgetVsActualWidget() {
  const { data, error } = useQuery(budgetVsActualQuery)
  const { data: me } = useQuery(meQuery)
  const rows: Row[] =
    data && data.rows.length > 0
      ? [
          ...data.rows.map((row) => ({ key: String(row.categoryId), name: row.categoryName, budgetCents: row.budgetCents, spentCents: row.spentCents })),
          { key: 'other', name: 'Spending outside Budgets', budgetCents: null, spentCents: data.otherCents },
          { key: 'uncategorised', name: 'Uncategorised (includes money in not yet given a Category)', budgetCents: null, spentCents: data.uncategorisedCents },
        ]
      : []
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
          {rows.length > 0 && (
            <p className="mb-3 text-muted-foreground">
              {formatMonth(data.month)}. Each month stands alone: a Budget you don't spend isn't carried over. Money back, such as a refund, comes off what you spent, so what's left can be more than the Budget.
              Transfers between your own Accounts, Pending Transactions and Loans aren't counted as spending.
            </p>
          )}
          <ResponsiveTable
            caption={`Budget and spending in ${formatMonth(data.month)} for each Category with a Budget, and the rest`}
            rows={rows}
            getRowKey={(row) => row.key}
            emptyMessage={`No Category has a Budget in ${formatMonth(data.month)}.${me?.role === 'admin' ? ' Set one on the Budgets page.' : ''}`}
            columns={[
              { key: 'category', header: 'Category', cell: (row) => row.name },
              { key: 'budget', header: 'Budget', align: 'end', cell: (row) => (row.budgetCents === null ? 'No Budget' : <span className={money}>{formatBalance(row.budgetCents)}</span>) },
              { key: 'spent', header: 'Spent', align: 'end', cell: (row) => <span className={money}>{spentText(row.spentCents)}</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (row) => {
                  if (row.budgetCents === null) return <Status tone="neutral">Not in a Budget</Status>
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
