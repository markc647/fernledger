import type { IncomeVsSpending, MonthFigures } from '@/generated/api/report-income-vs-spending'
import { Amount } from '@/components/amount'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { NOT_COUNTED_AS_SPENDING_OR_INCOME } from '@/lib/budgets'
import { describeDates } from '@/lib/charts'
import { formatMonth } from '@/lib/format'
import { partOfMonth } from '@/lib/income-vs-spending'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

// The amounts keep their digits together and give way last; the month's name, which can carry a sentence about the dates, is the column that wraps. Spending and
// Income are written as the Dashboard and the Spending by Category Report write them (`Spent`, "$15.00 back"; an Income below zero has its minus sign), in one weight.
const columns = (from: string, to: string): Column<MonthFigures>[] => [
  {
    key: 'month',
    header: 'Month',
    className: `${PAPER} [overflow-wrap:break-word]`,
    cell: (row) => {
      const part = partOfMonth(row.month, from, to)
      return (
        <>
          {formatMonth(row.month)}
          {part && (
            <>
              {' '}
              <span className="block">Only {part}</span>
            </>
          )}
        </>
      )
    },
  },
  { key: 'income', header: 'Income', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Amount cents={row.incomeCents} balance /> },
  {
    key: 'spending',
    header: 'Spending',
    align: 'end',
    className: `${PAPER} [overflow-wrap:normal]`,
    cell: (row) => (
      <span className="font-medium">
        <Spent cents={row.spendingCents} />
      </span>
    ),
  },
  { key: 'difference', header: 'Income less spending', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Amount cents={row.differenceCents} /> },
]

/** What a reader needs before the figures: what Income and Spending are, and what is not counted. */
function AboutIncomeVsSpending() {
  return (
    <section aria-labelledby="about-income-vs-spending" className="mt-6 print:mt-4">
      <h2 id="about-income-vs-spending" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">Income is what the Income Categories brought in each month, less what went out of them. A negative amount means more went out than came in.</p>
      <p className="mt-1">Spending is what the Spending Categories took out, less money back, such as a refund. A “back” amount is taken off the total.</p>
      <p className="mt-1">Uncategorised counts as spending, so money in that has no Category yet comes off it.</p>
      <p className="mt-1">{NOT_COUNTED_AS_SPENDING_OR_INCOME}</p>
    </section>
  )
}

/**
 * What came in as Income and what was spent as Spending in each month of the dates, with the totals before the table (so they never end up alone on a last page, and a
 * reader sees the sum before the detail). Every figure is the Worker's (worker/report-income-vs-spending.ts, ADR 0012); nothing is added up here. A month with
 * nothing in it has a row of zeros, so a quiet month is not mistaken for missing data, and a first or last month the dates cover only part of says so. `accounts` is
 * what the table's heading on paper says about the Accounts: a browser repeats that heading, and with it what is not counted, at the top of every page the table runs onto.
 */
export function IncomeVsSpendingReport({ report, accounts }: { report: IncomeVsSpending; accounts: string }) {
  const printHeading = useReportIdentity()(accounts, NOT_COUNTED_AS_SPENDING_OR_INCOME)
  const { totals } = report
  // A Report of dates with nothing in them says so rather than show a table of zeros.
  const nothing = report.months.every((month) => month.incomeCents === 0 && month.spendingCents === 0)
  return (
    <>
      <AboutIncomeVsSpending />
      <section aria-labelledby="income-vs-spending-heading" className="mt-8 print:mt-6">
        <h2 id="income-vs-spending-heading" className="text-xl font-semibold print:text-[15pt]">
          Income and spending by month
        </h2>
        {nothing ? (
          <p className="mt-2">There was no income or spending in {describeDates(report.from, report.to)}.</p>
        ) : (
          <>
            <dl className="mt-3 grid max-w-xl grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 break-inside-avoid">
              <dt className="font-semibold">Total income</dt>
              <dd className="text-end">
                <Amount cents={totals.incomeCents} balance />
              </dd>
              <dt className="font-semibold">Total spending</dt>
              <dd className="text-end font-medium">
                <Spent cents={totals.spendingCents} />
              </dd>
              <dt className="border-t pt-1 font-semibold">Income less spending</dt>
              <dd className="border-t pt-1 text-end">
                <Amount cents={totals.differenceCents} />
              </dd>
            </dl>
            <div className="mt-4">
              <ResponsiveTable
                caption="Income and spending by month"
                columns={columns(report.from, report.to)}
                rows={report.months}
                getRowKey={(row) => row.month}
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
