import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BudgetVsActual, WholeMonthsNotice } from '@/components/budget-report'
import { BudgetVsActualForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { reportBudgetQuery } from '@/lib/queries'
import { parseBudgetReportSearch, tooManyMonths } from '@/lib/report-budget'

// Like the other Reports, this one lives in its address (?from=2026-01-01&to=2026-06-30), so it can be reopened or sent on, and opens in a new window from the
// Reports page (target="_blank" with rel="noopener"). A Budget is for all Accounts together, so it has no `account`: one in the address is left out.
export const Route = createFileRoute('/reports_/budget-vs-actual')({
  component: BudgetVsActualReport,
  validateSearch: parseBudgetReportSearch,
})

const NAME = 'Budget vs actual'

function BudgetVsActualReport() {
  const search = Route.useSearch()
  return (
    <ReportGate
      name={NAME}
      search={search}
      form={<BudgetVsActualForm defaults={search} />}
      noAccounts="There are no Accounts yet, so there is no spending to compare with Budgets."
      rangeProblem={tooManyMonths}
    >
      {(scope) => <Budgets scope={scope} />}
    </ReportGate>
  )
}

/**
 * Each Spending Category's Budget against what it spent, month by month, for the months a range of dates touch (spec story 94). One request reads all of
 * them (ADR 0004). The title block names the whole months it covers, and a notice says so when the dates asked for were part of a month.
 */
function Budgets({ scope }: { scope: ReportScope }) {
  const budgets = useQuery(reportBudgetQuery(scope.from, scope.to))
  const waiting = reportWaiting(budgets)
  if (waiting) return waiting
  const report = budgets.data!

  return (
    <ReportFrame
      name={NAME}
      accounts={scope.accountsText}
      accountsInTitle={scope.accountsInTitle}
      from={report.covers.from}
      to={report.covers.to}
      generatedAt={budgets.dataUpdatedAt}
      notice={<WholeMonthsNotice report={report} />}
    >
      <BudgetVsActual report={report} accounts={scope.accountsInTitle} />
      <BackToReports />
    </ReportFrame>
  )
}
