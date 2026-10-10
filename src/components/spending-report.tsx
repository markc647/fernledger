import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { spentParts } from '@/lib/budgets'
import { NO_SPENDING, spendingRows, type SpendingReport, type SpendingRow } from '@/lib/report-spending'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

/**
 * What was spent, with no sign: money out less money back, as the Summary's Budget vs actual says it ("$55.50", or "$15.00 back" when more
 * came back than went out, such as a refund). The amount is kept in one piece and "back" is left free to wrap on a narrow screen.
 */
function Spent({ cents }: { cents: number }) {
  const { amount, back } = spentParts(cents)
  return (
    <>
      <span className="font-medium whitespace-nowrap tabular-nums [font-kerning:none]">{amount}</span>
      {back && ' back'}
    </>
  )
}

// The Category keeps its words together as far as it can, and breaks a very long one rather than push the page wider.
const columns: Column<SpendingRow>[] = [
  { key: 'category', header: 'Category', className: `${PAPER} [overflow-wrap:break-word]`, cell: (row) => row.name },
  { key: 'spent', header: 'Spent', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Spent cents={row.cents} /> },
]

/** What a reader needs before the figures: what is counted as Spending, and what is not. */
function AboutSpending() {
  return (
    <section aria-labelledby="about-spending" className="mt-6 print:mt-4">
      <h2 id="about-spending" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">
        Spending is the money that went out of the Accounts, Category by Category, in these dates, less any money that came back, such as a refund. Where more came back than went out, the Category
        says “back”.
      </p>
      <p className="mt-1">
        Transactions that have no Category yet count as Spending too. They are in the Uncategorised row, which includes any money in that has not been given a Category.
      </p>
      <p className="mt-1">Transfers between your own Accounts, Pending Transactions, Loans and Income are not Spending, so they are not here.</p>
    </section>
  )
}

/**
 * What each Spending Category spent in the dates, largest first, with Uncategorised on its own and the total before them. The total comes before the
 * table, so it never ends up alone on a last page and a reader sees the sum before the detail. `accounts` is what the table's heading on paper says
 * about the Accounts (a browser repeats it at the top of every page the table runs onto).
 */
export function SpendingByCategory({ report, accounts }: { report: SpendingReport; accounts: string }) {
  const rows = spendingRows(report)
  const printHeading = useReportIdentity()(accounts)
  return (
    <>
      <AboutSpending />
      <section aria-labelledby="spending-heading" className="mt-8 print:mt-6">
        <h2 id="spending-heading" className="text-xl font-semibold print:text-[15pt]">
          Spending in each Category
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2">{NO_SPENDING}</p>
        ) : (
          <>
            <dl className="mt-3 grid max-w-sm grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 break-inside-avoid">
              <dt className="font-semibold">Total spending</dt>
              <dd className="text-end">
                <Spent cents={report.totalCents} />
              </dd>
            </dl>
            <div className="mt-4">
              <ResponsiveTable caption="Spending in each Category" columns={columns} rows={rows} getRowKey={(row) => row.key} className="print:text-[12pt]" printHeading={printHeading} />
            </div>
          </>
        )}
      </section>
    </>
  )
}
