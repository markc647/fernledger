import type { ReactNode } from 'react'
import { budgetColumns } from '@/components/budget-columns'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { Status } from '@/components/status'
import { budgetRows, budgetStatus, NOT_COUNTED } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { hasNoBudgets, monthNote, overMonthsText, periodRows, togetherCovers, wholeMonthsNotice, type BudgetReport, type PeriodRow, type ReportMonth } from '@/lib/report-budget'
import { MONEY_TEXT } from '@/lib/utils'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

const monthColumns = budgetColumns(PAPER)
// The months together have no Status for a Category: a month over Budget and a month under it would cancel out, so the last column counts the months it was over.
// What is not in a Budget has no months over, said by a dash on screen and in words to a screen reader.
const periodColumns: Column<PeriodRow>[] = [
  ...monthColumns.slice(0, 3),
  {
    key: 'over',
    header: 'Months over Budget',
    className: PAPER,
    cell: (row) =>
      row.overMonths ?? (
        <>
          <span aria-hidden="true">–</span>
          <span className="sr-only">Not in a Budget</span>
        </>
      ),
  },
]

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6">
      <dt className="font-semibold">{label}</dt>
      <dd className="ms-auto text-end">{children}</dd>
    </div>
  )
}

/**
 * The Budgets and the spending in all, before the table, so they never end up alone on a last page: the Budgets added up, what the Categories with a Budget
 * spent and where that leaves them (the same words as a row's Status, from `budgetStatus`), then everything spent, including what is outside Budgets. Without
 * `budget` (no Category has a Budget) there is only the spending. Each pair wraps (the figure goes under its words) when a big figure at the largest text size
 * does not fit beside them on a phone.
 */
function Totals({ budget, spentCents, overMonths }: { budget: { budgetCents: number; budgetedSpentCents: number } | null; spentCents: number; overMonths?: string }) {
  const net = budget && budgetStatus(budget.budgetCents, budget.budgetedSpentCents)
  return (
    <dl className="mt-3 grid max-w-xl gap-y-1 break-inside-avoid">
      {budget && net && (
        <>
          <Pair label="Total Budget">
            <span className={MONEY_TEXT}>{formatBalance(budget.budgetCents)}</span>
          </Pair>
          <Pair label="Spent in Categories with a Budget">
            <Spent cents={budget.budgetedSpentCents} />
          </Pair>
          <Pair label="Against the Budgets">
            <span className="inline-flex flex-col items-end">
              <Status tone={net.tone}>{net.words}</Status>
              <span className="tabular-nums">{net.detail}</span>
            </span>
          </Pair>
          {overMonths && <Pair label="Months over Budget">{overMonths}</Pair>}
        </>
      )}
      <Pair label="Total spending">
        <Spent cents={spentCents} />
      </Pair>
    </dl>
  )
}

/** Said under the title block when the dates asked for were part of a month, because a Budget is for a whole month; nothing when they were whole months. */
export function WholeMonthsNotice({ report }: { report: BudgetReport }) {
  const words = wholeMonthsNotice(report)
  return words === null ? null : <p className="mt-6 border-2 border-foreground p-3 font-semibold break-inside-avoid">{words}</p>
}

/** What a reader needs before the figures: which Budget a month has, what counts as spending and what does not, and how Categories are taken. */
function AboutFigures() {
  return (
    <section aria-labelledby="about-figures" className="mt-6 print:mt-4">
      <h2 id="about-figures" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">
        Each month is compared with the Budget in effect for it. A Budget applies from the month it begins until it is changed or ended, so changing a Budget never alters an earlier month, and
        nothing a Category doesn't spend is carried over to the next month. Where a Category's Budget changes, its row says so.
      </p>
      <p className="mt-1">
        Spent is money out less money back. A refund comes off what a Category spent, so what's left can be more than the Budget, and a Category that took in more than it paid out reads “back”.
        Uncategorised counts as spending, so money in that has no Category yet comes off it. Total spending is everything spent in the month, including Categories with no Budget: a Category's
        spending in a month it has no Budget is in Spending outside Budgets.
      </p>
      <p className="mt-1">{NOT_COUNTED}</p>
      <p className="mt-1">
        Categories are taken as they are now. A Category that has since been made Income or Loans, or removed, is out of every month shown, past ones too, and a Budget kept for it is not used.
      </p>
    </section>
  )
}

/**
 * The months that have ended added together, when there is more than one month: a Category's Budget and spending over the months it had a Budget, and how many of
 * them it was over. It says which months it covers and why. The months that have not ended are in the Report on their own, not in these figures.
 */
function AllMonths({ report, accounts }: { report: BudgetReport; accounts: string }) {
  const printHeading = useReportIdentity()(accounts, NOT_COUNTED)
  const { together, total } = report
  return (
    <section aria-labelledby="all-months" className="mt-8 print:mt-6">
      <h2 id="all-months" className="text-xl font-semibold print:text-[15pt]">
        All months together
      </h2>
      <p className="mt-1">{togetherCovers(report)}</p>
      {together !== null && (
        <>
          {report.categories.length > 0 && (
            <p className="mt-1">
              A Category's Budget and spending are added up over the months it had a Budget. A month over Budget and a month under it are both in the totals, so the last column counts the months each
              Category was over Budget.
            </p>
          )}
          <Totals
            budget={report.categories.length > 0 ? { budgetCents: total.budgetCents, budgetedSpentCents: total.budgetedSpentCents } : null}
            spentCents={total.spentCents}
            overMonths={overMonthsText(total.overMonths, total.budgetMonths)}
          />
          <div className="mt-4">
            <ResponsiveTable
              caption={`Budget and spending in the months that have ended from ${formatMonth(together.first)} to ${formatMonth(together.last)}, for each Category with a Budget, and the rest`}
              columns={periodColumns}
              rows={periodRows(report)}
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

/** One month: its Budgets against what was spent, as the Summary shows a month, with what is not in a Budget below them. */
function MonthSection({ month, noBudgets, accounts }: { month: ReportMonth; noBudgets: boolean; accounts: string }) {
  const printHeading = useReportIdentity()(accounts, NOT_COUNTED)
  const id = `month-${month.month}`
  const label = formatMonth(month.month)
  const note = monthNote(month.state)
  const hasBudgets = month.rows.length > 0
  const nothing = !hasBudgets && month.otherCents === 0 && month.uncategorisedCents === 0
  return (
    <section aria-labelledby={id} className="mt-8 print:mt-6">
      <h2 id={id} className="text-xl font-semibold print:text-[15pt]">
        {label}
      </h2>
      {note !== null && <p className="mt-1">{note}</p>}
      {nothing ? (
        <p className="mt-1">{noBudgets ? `Nothing was spent in ${label}.` : `No Category has a Budget in ${label}, and nothing was spent.`}</p>
      ) : (
        <>
          {!hasBudgets && !noBudgets && <p className="mt-1">No Category has a Budget in {label}.</p>}
          <Totals budget={hasBudgets ? { budgetCents: month.budgetCents, budgetedSpentCents: month.budgetedSpentCents } : null} spentCents={month.spentCents} />
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
 * Each Spending Category's Budget against what it spent, a section for every month and, for more than one, the months that have ended together first (spec story 94).
 * `accounts` is how the table headings on paper name the Accounts ("All Accounts"), which the title block lists in full.
 */
export function BudgetVsActual({ report, accounts }: { report: BudgetReport; accounts: string }) {
  const noBudgets = hasNoBudgets(report)
  return (
    <>
      <AboutFigures />
      {noBudgets && <p className="mt-4 font-semibold">No Category has a Budget in these months, so all of the spending is outside Budgets.</p>}
      {report.months.length > 1 && <AllMonths report={report} accounts={accounts} />}
      {report.months.map((month) => (
        <MonthSection key={month.month} month={month} noBudgets={noBudgets} accounts={accounts} />
      ))}
    </>
  )
}
