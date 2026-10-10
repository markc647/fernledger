import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ReportFrame } from '@/components/report-frame'
import { TransactionListingForm } from '@/components/report-form'
import { CappedNotice, TransactionListing } from '@/components/transaction-listing'
import { accountsQuery, reportListingQuery } from '@/lib/queries'
import { parseReportSearch } from '@/lib/report-transactions'

// The Report lives in its address (?account=2&from=2026-10-01&to=2026-10-31), so it can be reopened or sent on, and the
// Transactions page and the Reports page open it by link. It opens in a new window (target="_blank" with rel="noopener").
export const Route = createFileRoute('/reports_/transactions')({
  component: TransactionListingReport,
  validateSearch: parseReportSearch,
})

const NAME = 'Transaction listing'

/** Not a Report yet: the heading, what is missing, and the form that opens the Report once it is filled in. */
function Needs({ message, alert = false }: { message: string; alert?: boolean }) {
  const search = Route.useSearch()
  return (
    <>
      <h1 className="text-2xl font-semibold">{NAME}</h1>
      <p role={alert ? 'alert' : 'status'} className="mt-2">
        {message}
      </p>
      <div className="mt-4">
        <TransactionListingForm defaults={search} />
      </div>
    </>
  )
}

/**
 * Every Transaction in a date range, with its Category and Note, Account by Account, for a family, a lawyer or the court
 * (spec stories 97 to 99). It is read a page at a time and stops at the cap, which it says (REPORT_ROW_CAP).
 */
function TransactionListingReport() {
  const search = Route.useSearch()
  const accounts = useQuery(accountsQuery)
  const range = search.from && search.to ? { from: search.from, to: search.to } : null
  const backwards = range !== null && range.from > range.to
  const selected = accounts.data && (search.account === undefined ? accounts.data : accounts.data.filter((a) => a.id === search.account))
  const ready = range !== null && !backwards && selected !== undefined && selected.length > 0
  const listing = useQuery({ ...reportListingQuery(selected ?? [], range?.from ?? '', range?.to ?? ''), enabled: ready })

  if (accounts.error) return <p role="alert">Fernledger couldn't load the Accounts. Reload the page to try again.</p>
  if (range === null) return <Needs message="Choose the first and last dates this Report covers." />
  if (backwards) return <Needs alert message="The “To” date is before the “From” date. Change one of them to open the Report." />
  if (!selected) return <p role="status">Loading…</p>
  if (selected.length === 0) {
    return accounts.data!.length === 0 ? (
      <>
        <h1 className="text-2xl font-semibold">{NAME}</h1>
        <p className="mt-2">There are no Accounts yet, so there is nothing to list. An Account is added the first time the Admin imports a file for it.</p>
      </>
    ) : (
      <Needs alert message="There is no such Account. Choose one below." />
    )
  }
  if (listing.error) return <p role="alert">Fernledger couldn't load this Report. Reload the page to try again.</p>
  if (!listing.data) return <p role="status">Loading…</p>

  const names = selected.map((a) => a.name).join(', ')
  return (
    <ReportFrame
      name={NAME}
      accounts={search.account === undefined ? `All Accounts (${names})` : names}
      from={range.from}
      to={range.to}
      generatedAt={listing.dataUpdatedAt}
      notice={listing.data.capped ? <CappedNotice alert /> : undefined}
    >
      <TransactionListing listing={listing.data} />
      <p className="mt-8 print:hidden">
        <Link to="/reports" className="underline underline-offset-4">
          Back to Reports
        </Link>
      </p>
    </ReportFrame>
  )
}
