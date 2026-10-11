import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SpendingForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { SpendingByCategoryReport } from '@/components/spending-report'
import { reportSpendingQuery } from '@/lib/queries'
import { parseReportSearch } from '@/lib/report-transactions'

// Like the other Reports, this one lives in its address (?account=2&from=2026-10-01&to=2026-10-31, the Account left out for all of them), so it can
// be reopened or sent on. It opens in a new window from the Reports page (target="_blank" with rel="noopener").
export const Route = createFileRoute('/reports_/spending')({
  component: SpendingReport,
  validateSearch: parseReportSearch,
})

const NAME = 'Spending by Category'

function SpendingReport() {
  const search = Route.useSearch()
  return (
    <ReportGate name={NAME} search={search} form={<SpendingForm defaults={search} />} noAccounts="There are no Accounts yet, so there is no spending.">
      {(scope) => <Spending scope={scope} account={search.account} />}
    </ReportGate>
  )
}

/**
 * What each Category spent over a range of dates, for all the Accounts or the one chosen (spec story 93). It asks once, whatever the number of Accounts, and adds,
 * names and orders nothing: the Worker gives the Dashboard's own answer (worker/spending-by-category.ts, ADR 0012).
 */
function Spending({ scope, account }: { scope: ReportScope; account: number | undefined }) {
  const spending = useQuery(reportSpendingQuery(account, scope.from, scope.to))
  const waiting = reportWaiting(spending)
  if (waiting) return waiting

  // The title block lists the Accounts; the table's heading, which is repeated on every printed page, says "All Accounts" rather than list them each time.
  const accountsInHeading = account === undefined ? 'All Accounts' : scope.accountsText
  return (
    <ReportFrame name={NAME} accounts={scope.accountsText} accountsInTitle={scope.accountsInTitle} from={scope.from} to={scope.to} generatedAt={spending.dataUpdatedAt}>
      <SpendingByCategoryReport report={spending.data!} accounts={accountsInHeading} />
      <BackToReports />
    </ReportFrame>
  )
}
