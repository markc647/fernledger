import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BalancesOverTime } from '@/components/balances-report'
import { BalancesForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { reportBalancesQuery } from '@/lib/queries'
import { parseReportSearch } from '@/lib/report-transactions'
import { reportNav } from '@/lib/report-nav'
import { REPORTS } from '@/lib/reports'

// Like the Transaction listing, the Report lives in its address (?account=2&from=2026-01-01&to=2026-12-31), so it can be reopened
// or sent on. The form is on the page with the Report.
export const Route = createFileRoute('/reports_/balances')({
  component: BalancesReport,
  validateSearch: parseReportSearch,
  staticData: { nav: reportNav(REPORTS.balances) },
})

const REPORT = REPORTS.balances

function BalancesReport() {
  const search = Route.useSearch()
  return (
    <ReportGate report={REPORT} search={search} form={<BalancesForm defaults={search} />} noAccounts="There are no Accounts yet, so there are no balances.">
      {(scope) => <Balances scope={scope} />}
    </ReportGate>
  )
}

/**
 * Each Account's balance at the end of every month in a date range, from its balance history (spec story 96). It asks about one
 * Account at a time, so each request stays small (ADR 0004).
 */
function Balances({ scope }: { scope: ReportScope }) {
  const balances = useQuery(reportBalancesQuery(scope.accounts, scope.from, scope.to))
  const waiting = reportWaiting(balances)
  if (waiting) return waiting

  return (
    <ReportFrame name={REPORT.name} accounts={scope.accountsText} accountsInTitle={scope.accountsInTitle} from={scope.from} to={scope.to} generatedAt={balances.dataUpdatedAt}>
      <BalancesOverTime sections={balances.data!} />
      <BackToReports />
    </ReportFrame>
  )
}
