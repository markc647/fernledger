import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TransactionListingForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { BackToReports, ReportGate, reportWaiting, type ReportScope } from '@/components/report-gate'
import { CappedNotice, TransactionListing } from '@/components/transaction-listing'
import { reportListingQuery } from '@/lib/queries'
import { parseReportSearch } from '@/lib/report-transactions'

// The Report lives in its address (?account=2&from=2026-10-01&to=2026-10-31), so it can be reopened or sent on, and the
// Transactions page and the Reports page open it by link. It opens in a new window (target="_blank" with rel="noopener").
export const Route = createFileRoute('/reports_/transactions')({
  component: TransactionListingReport,
  validateSearch: parseReportSearch,
})

const NAME = 'Transaction listing'

function TransactionListingReport() {
  const search = Route.useSearch()
  return (
    <ReportGate name={NAME} search={search} form={<TransactionListingForm defaults={search} />} noAccounts="There are no Accounts yet, so there is nothing to list.">
      {(scope) => <Listing scope={scope} />}
    </ReportGate>
  )
}

/**
 * Every Transaction in a date range, with its Category and Note, Account by Account, for a family, a lawyer or the court
 * (spec stories 97 to 99). It is read a page at a time and stops at the cap, which it says (REPORT_ROW_CAP).
 */
function Listing({ scope }: { scope: ReportScope }) {
  const listing = useQuery(reportListingQuery(scope.accounts, scope.from, scope.to))
  const waiting = reportWaiting(listing)
  if (waiting) return waiting

  return (
    <ReportFrame
      name={NAME}
      accounts={scope.accountsText}
      accountsInTitle={scope.accountsInTitle}
      from={scope.from}
      to={scope.to}
      generatedAt={listing.dataUpdatedAt}
      notice={listing.data!.capped ? <CappedNotice alert /> : undefined}
    >
      <TransactionListing listing={listing.data!} />
      <BackToReports />
    </ReportFrame>
  )
}
