import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LoansCappedNotice, LoansReport } from '@/components/loans-report'
import { LoansForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, Needs, NeedsChange, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { reportLoansQuery } from '@/lib/queries'
import { parseLoansSearch, type LoansSearch } from '@/lib/report-loans'
import { reportNav } from '@/lib/report-nav'
import { REPORTS } from '@/lib/reports'

// The Report lives in its address (?category=3&from=2026-01-01&to=2026-10-31), so it can be reopened or sent on, and a kept Report on the Reports page opens at it. The Admin's form is on the
// page with the Report; a Member has none. Without a category it is every Loans Category; without `from` it begins at the first Transaction.
export const Route = createFileRoute('/reports_/loans')({
  component: LoansReportPage,
  validateSearch: parseLoansSearch,
  staticData: { nav: reportNav(REPORTS.loans) },
})

const REPORT = REPORTS.loans

function LoansReportPage() {
  const search = Route.useSearch()
  return (
    <ReportGate
      report={REPORT}
      search={{ from: search.from, to: search.to }}
      fromOptional
      form={<LoansForm defaults={search} />}
      noAccounts="There are no Accounts yet, so there is no loan to list."
    >
      {(scope) => <Loans scope={scope} search={search} />}
    </ReportGate>
  )
}

/**
 * How much each Loans Category's person owes, or is owed, with the lending and repayments that make it up (the family's record of a loan to a child, or from one). It is
 * read a page at a time and stops at its cap (`LOANS_ROW_CAP`), which it says. It lists the Loans Category chosen, or each one, and says so when there is none to list.
 */
function Loans({ scope, search }: { scope: ReportScope; search: LoansSearch }) {
  const loans = useQuery(reportLoansQuery(search.category, search.from, scope.to))
  const waiting = reportWaiting(loans)
  if (waiting) return waiting
  const { available, listing } = loans.data!

  if (available === 0) {
    return <Needs message="There are no Loans Categories to report on yet." />
  }
  if (listing.sections.length === 0) {
    return <NeedsChange message="There is no such Loans Category. It may have been removed, or may no longer be a Loans Category. Choose one in the form above." />
  }
  const chosen = search.category === undefined ? null : listing.sections[0]!
  return (
    <ReportFrame
      name={REPORT.name}
      accounts={scope.accountsText}
      accountsInTitle={chosen ? chosen.name : 'All loans'}
      from={search.from ?? null}
      to={scope.to}
      subject={{ label: 'Loans', text: chosen ? chosen.name : 'All Loans Categories' }}
      generatedAt={loans.dataUpdatedAt}
      notice={listing.capped ? <LoansCappedNotice alert /> : undefined}
    >
      <LoansReport loans={listing} from={search.from ?? null} to={scope.to} all={chosen === null} />
      <BackToReports />
    </ReportFrame>
  )
}
