import { budgetColumns } from '@/components/budget-columns'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { Status } from '@/components/status'
import { budgetRows } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { monthNote, monthState, periodRows, wholeMonthsNotice, type BudgetReport, type PeriodRow, type ReportMonth } from '@/lib/report-budget'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'
const money = 'whitespace-nowrap tabular-nums [font-kerning:none]'

const monthColumns = budgetColumns(PAPER)
// The months added together have no Status: a month over Budget and a month under it would cancel out, so the last column counts the months that were over.
const periodColumns: Column<PeriodRow>[] = [
  ...monthColumns.slice(0, 3),
  { key: 'over', header: 'Over Budget', className: PAPER, cell: (row) => row.overMonths ?? <Status tone="neutral">Not in a Budget</Status> },
]

/**
 * The Budget and spending in all, before the table, so they never end up alone on a last page. `budgetCents` is left out while no Category has a Budget. Each pair wraps
 * (the figure goes under its words) when a big figure at the largest text size does not fit beside them on a phone.
 */
function Totals({ budgetCents, spentCents }: { budgetCents: number | null; spentCents: number }) {
  const pair = 'flex flex-wrap items-baseline justify-between gap-x-6'
  return (
    <dl className="mt-3 grid max-w-xl gap-y-1 break-inside-avoid">
      {budgetCents !== null && (
        <div className={pair}>
          <dt>Total Budget</dt>
          <dd className="ms-auto">
            <span className={money}>{formatBalance(budgetCents)}</span>
          </dd>
        </div>
      )}
      <div className={pair}>
        <dt>Total spending</dt>
        <dd className="ms-auto text-end">
          <Spent cents={spentCents} />
        </dd>
      </div>
    </dl>
  )
}

/** Said under the title block when the dates asked for were part of a month, because a Budget is for a whole month; nothing when they were whole months. */
export function WholeMonthsNotice({ report }: { report: BudgetReport }) {
  const words = wholeMonthsNotice(report)
  return words === null ? null : <p className="mt-6 border-2 border-foreground p-3 font-semibold break-inside-avoid">{words}</p>
}

/** What a reader needs before the figures: which Budget a month has, what counts as spending, and what the totals are. */
function AboutFigures() {
  return (
    <section aria-labelledby="about-figures" className="mt-6 print:mt-4">
      <h2 id="about-figures" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">
        Each month is compared with the Budget the Admin had set for it. A Budget applies from the month it begins until it is changed or ended, so changing a Budget never alters an earlier month,
        and nothing a Category doesn't spend is carried over to the next month.
      </p>
      <p className="mt-1">
        Spent is money out less money back, so a refund comes off what a Category spent, and a Category that took in more than it paid out reads “back”. Transfers between your own Accounts, Pending
        Transactions, Income and Loans are not counted. Uncategorised counts as spending, so money in that has no Category yet comes off it. Total spending is everything spent in the month,
        including Categories with no Budget.
      </p>
    </section>
  )
}

/** The months added together, when there is more than one: a Category's Budget and spending over the months it had a Budget, and how many of them it was over. */
function AllMonths({ report, accounts }: { report: BudgetReport; accounts: string }) {
  const printHeading = useReportIdentity()(accounts)
  const rows = periodRows(report)
  return (
    <section aria-labelledby="all-months" className="mt-8 print:mt-6">
      <h2 id="all-months" className="text-xl font-semibold print:text-[15pt]">
        All months together
      </h2>
      <p className="mt-1">
        {formatMonth(report.months[0]!.month)} to {formatMonth(report.months.at(-1)!.month)}. A Budget and what was spent are added up over the months a Category had a Budget. A month over Budget and
        a month under it are both in the totals, so the last column counts how many of those months were over Budget.
      </p>
      <Totals budgetCents={report.categories.length > 0 ? report.total.budgetCents : null} spentCents={report.total.spentCents} />
      <div className="mt-4">
        <ResponsiveTable
          caption={`Budget and spending from ${formatMonth(report.months[0]!.month)} to ${formatMonth(report.months.at(-1)!.month)} for each Category with a Budget, and the rest`}
          columns={periodColumns}
          rows={rows}
          getRowKey={(row) => row.key}
          className="print:text-[12pt]"
          printHeading={printHeading}
        />
      </div>
    </section>
  )
}

/** One month: its Budgets against what was spent, as the Summary shows a month, with what is not in a Budget below them. */
function MonthSection({ month, thisMonth, accounts }: { month: ReportMonth; thisMonth: string; accounts: string }) {
  const printHeading = useReportIdentity()(accounts)
  const id = `month-${month.month}`
  const label = formatMonth(month.month)
  const note = monthNote(monthState(month.month, thisMonth))
  const hasBudgets = month.rows.length > 0
  const nothing = !hasBudgets && month.otherCents === 0 && month.uncategorisedCents === 0
  return (
    <section aria-labelledby={id} className="mt-8 print:mt-6">
      <h2 id={id} className="text-xl font-semibold print:text-[15pt]">
        {label}
      </h2>
      {note !== null && <p className="mt-1">{note}</p>}
      {nothing ? (
        <p className="mt-1">No Category has a Budget in {label}, and nothing was spent.</p>
      ) : (
        <>
          {!hasBudgets && <p className="mt-1">No Category has a Budget in {label}.</p>}
          <Totals budgetCents={hasBudgets ? month.budgetCents : null} spentCents={month.spentCents} />
          <div className="mt-4">
            <ResponsiveTable
              caption={`Budget and spending in ${label} for each Category with a Budget, and the rest`}
              columns={monthColumns}
              rows={budgetRows(month)}
              getRowKey={(row) => row.key}
              className="print:text-[12pt]"
              printHeading={printHeading}
            />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Each Spending Category's Budget against what it spent, a section for every month and, for more than one, the months together first (spec story 94).
 * `accounts` is how the table headings on paper name the Accounts ("All Accounts"), which the title block lists in full.
 */
export function BudgetVsActual({ report, accounts }: { report: BudgetReport; accounts: string }) {
  return (
    <>
      <AboutFigures />
      {report.months.length > 1 && <AllMonths report={report} accounts={accounts} />}
      {report.months.map((month) => (
        <MonthSection key={month.month} month={month} thisMonth={report.thisMonth} accounts={accounts} />
      ))}
    </>
  )
}
