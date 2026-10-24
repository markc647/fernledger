import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { INCOME_VS_SPENDING_NOTES, IncomeVsSpendingReport } from '@/components/income-vs-spending-report'
import { IncomeVsSpendingForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { tooManyIncomeMonths } from '@/lib/income-vs-spending'
import { reportIncomeVsSpendingQuery } from '@/lib/queries'
import { parseReportSearch } from '@/lib/report-transactions'
import { reportNav } from '@/lib/report-nav'
import { REPORTS } from '@/lib/reports'

// Like the other Reports, this one lives in its address (?account=2&from=2026-01-01&to=2026-12-31, the Account left out for all of them), so it can be reopened
// or sent on. The form is on the page with the Report.
export const Route = createFileRoute('/reports_/income-vs-spending')({
  component: IncomeVsSpendingPage,
  validateSearch: parseReportSearch,
  staticData: { nav: reportNav(REPORTS.incomeVsSpending) },
})

const REPORT = REPORTS.incomeVsSpending

function IncomeVsSpendingPage() {
  const search = Route.useSearch()
  return (
    <ReportGate
      report={REPORT}
      search={search}
      form={<IncomeVsSpendingForm defaults={search} />}
      noAccounts="There are no Accounts yet, so there is no income or spending."
      rangeProblem={tooManyIncomeMonths}
    >
      {(scope) => <IncomeVsSpending scope={scope} account={search.account} />}
    </ReportGate>
  )
}

/**
 * What came in and what was spent in each month of a range of dates, for all the Accounts or the one chosen (spec story 95). It asks once, whatever the number of
 * Accounts, and adds up nothing: the Worker gives each month's Income and Spending from the one place that works them out (worker/spending.ts, ADR 0012).
 */
function IncomeVsSpending({ scope, account }: { scope: ReportScope; account: number | undefined }) {
  const report = useQuery(reportIncomeVsSpendingQuery(account, scope.from, scope.to))
  const waiting = reportWaiting(report)
  if (waiting) return waiting

  // The title block lists the Accounts; the table's heading, which is repeated on every printed page, says "All Accounts" rather than list them each time.
  const accountsInHeading = account === undefined ? 'All Accounts' : scope.accountsText
  return (
    <ReportFrame name={REPORT.name} accounts={scope.accountsText} accountsInTitle={scope.accountsInTitle} from={scope.from} to={scope.to} generatedAt={report.dataUpdatedAt} notes={INCOME_VS_SPENDING_NOTES}>
      <IncomeVsSpendingReport report={report.data!} accounts={accountsInHeading} />
      <BackToReports />
    </ReportFrame>
  )
}
