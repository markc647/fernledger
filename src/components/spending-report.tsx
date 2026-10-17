import type { SpendingByCategory, SpendingCategory } from '@/generated/api/spending-by-category'
import { LazySpendingChart } from '@/components/charts/lazy-charts'
import { useReportIdentity, type ReportNotes } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { NOT_COUNTED, UNCATEGORISED_SPENDING } from '@/lib/budgets'
import { barsOf, describeDates, spendingSummary } from '@/lib/charts'
import { PAPER } from '@/lib/utils'

// The Category keeps its words together as far as it can, and breaks a very long one rather than push the page wider. Uncategorised is named as the Summary and the
// Dashboard name it, so the row itself says that it includes money in that has no Category yet, wherever it falls in the order.
const columns: Column<SpendingCategory>[] = [
  { key: 'category', header: 'Category', className: `${PAPER} [overflow-wrap:break-word]`, cell: (row) => (row.categoryId === null ? UNCATEGORISED_SPENDING : row.name) },
  { key: 'spent', header: 'Spent', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Spent cents={row.cents} /> },
]

/** What a reader needs before the figures: what is counted as spending, and what is not. The "?" beside the Report's title has it on screen, and a printout has it before the figures (`ReportFrame`). */
export const SPENDING_NOTES: ReportNotes = {
  title: 'About these figures',
  body: (
    <>
      <p>What the Categories spent in these dates: money out less money back, such as a refund. A “back” amount is taken off the total.</p>
      <p>Uncategorised counts as spending, so money in that has no Category yet comes off it.</p>
      <p>{NOT_COUNTED}</p>
    </>
  ),
}

/**
 * The Report as a picture, for the screen: bars for the biggest Categories, drawn from the Report's own figures (`barsOf`), so it asks the Worker for nothing and cannot differ from the table.
 * It is left out of print (`print:hidden`), where the table is the Report and its layout is as it was. What there is to say when there are no bars, or more Categories than bars, is said here.
 */
function SpendingPicture({ report }: { report: SpendingByCategory }) {
  const { bars, leftOut } = barsOf(report.categories)
  const dates = describeDates(report.from, report.to)
  return (
    <div className="mt-4 print:hidden">
      {bars.length > 0 ? (
        <LazySpendingChart bars={bars} label={spendingSummary(dates, bars.length)} />
      ) : (
        <p className="font-medium">Nothing was spent above zero in {dates}: every Category took back as much as it spent, or more. The table shows what came back.</p>
      )}
      {leftOut > 0 && (
        <p className="mt-2 text-muted-foreground">
          The chart shows the biggest {bars.length} Categories. The table has {leftOut === 1 ? 'the other one' : `the other ${leftOut}`} too.
        </p>
      )}
    </div>
  )
}

/**
 * What each Category spent in the dates, in the order the Worker gives (the most spent first), with the total before them and, on the screen, a bar chart of the biggest between the total
 * and the table. The total comes before the table, so it never ends up alone on a last page and a reader sees the sum before the detail. `accounts` is what the table's heading on paper says
 * about the Accounts: a browser repeats that heading, and with it what is not counted, at the top of every page the table runs onto.
 */
export function SpendingByCategoryReport({ report, accounts }: { report: SpendingByCategory; accounts: string }) {
  const printHeading = useReportIdentity()(accounts, NOT_COUNTED)
  return (
    <>
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
            <SpendingPicture report={report} />
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
