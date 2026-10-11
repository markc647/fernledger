import type { SpendingByCategory, SpendingCategory } from '@/generated/api/spending-by-category'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { UNCATEGORISED_SPENDING } from '@/lib/budgets'
import { describeDates } from '@/lib/charts'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

/** What is left out, in the Dashboard's words. It is said before the figures and again in the heading of the table, so every printed page says it. */
const NOT_COUNTED = "Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted."

// The Category keeps its words together as far as it can, and breaks a very long one rather than push the page wider. Uncategorised is named as the Summary and the
// Dashboard name it, so the row itself says that it includes money in that has no Category yet, wherever it falls in the order.
const columns: Column<SpendingCategory>[] = [
  { key: 'category', header: 'Category', className: `${PAPER} [overflow-wrap:break-word]`, cell: (row) => (row.categoryId === null ? UNCATEGORISED_SPENDING : row.name) },
  { key: 'spent', header: 'Spent', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Spent cents={row.cents} /> },
]

/** What a reader needs before the figures: what is counted as spending, and what is not. */
function AboutSpending() {
  return (
    <section aria-labelledby="about-spending" className="mt-6 print:mt-4">
      <h2 id="about-spending" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">What the Categories spent in these dates: money out less money back, such as a refund. A “back” amount is taken off the total.</p>
      <p className="mt-1">Uncategorised counts as spending, so money in that has no Category yet comes off it.</p>
      <p className="mt-1">{NOT_COUNTED}</p>
    </section>
  )
}

/**
 * What each Category spent in the dates, in the order the Worker gives (the most spent first, as on the Dashboard), with the total before them. The total comes
 * before the table, so it never ends up alone on a last page and a reader sees the sum before the detail. `accounts` is what the table's heading on paper says about
 * the Accounts: a browser repeats that heading, and with it what is not counted, at the top of every page the table runs onto.
 */
export function SpendingByCategoryReport({ report, accounts }: { report: SpendingByCategory; accounts: string }) {
  const identity = useReportIdentity()(accounts)
  const printHeading = identity && (
    <>
      {identity}
      <span className="block">{NOT_COUNTED}</span>
    </>
  )
  return (
    <>
      <AboutSpending />
      <section aria-labelledby="spending-heading" className="mt-8 print:mt-6">
        <h2 id="spending-heading" className="text-xl font-semibold print:text-[15pt]">
          Spending in each Category
        </h2>
        {report.categories.length === 0 ? (
          <p className="mt-2">Nothing was spent in {describeDates(report.from, report.to)}.</p>
        ) : (
          <>
            <dl className="mt-3 grid max-w-sm grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 break-inside-avoid">
              <dt className="font-semibold">Total spending</dt>
              <dd className="text-end">
                <Spent cents={report.totalCents} />
              </dd>
            </dl>
            <div className="mt-4">
              <ResponsiveTable
                caption="Spending in each Category"
                columns={columns}
                rows={report.categories}
                getRowKey={(row) => row.categoryId ?? 'uncategorised'}
                className="print:text-[12pt]"
                printHeading={printHeading}
              />
            </div>
          </>
        )}
      </section>
    </>
  )
}
