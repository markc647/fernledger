import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { BalancesOverTime } from '@/components/balances-report'
import { BalancesForm } from '@/components/report-form'
import { ReportFrame } from '@/components/report-frame'
import { accountsQuery, reportBalancesQuery } from '@/lib/queries'
import { accountLabel } from '@/lib/report-frame'
import { parseReportSearch } from '@/lib/report-transactions'

// Like the Transaction listing, the Report lives in its address (?account=2&from=2026-01-01&to=2026-12-31), so it can be reopened
// or sent on. It opens in a new window from the Reports page (target="_blank" with rel="noopener").
export const Route = createFileRoute('/reports_/balances')({
  component: BalancesReport,
  validateSearch: parseReportSearch,
})

const NAME = 'Balances over time'

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
        <BalancesForm defaults={search} />
      </div>
    </>
  )
}

/**
 * Each Account's balance at the end of every month in a date range, from its balance history (spec story 96). It asks about one
 * Account at a time, so each request stays small (ADR 0004).
 */
function BalancesReport() {
  const search = Route.useSearch()
  const accounts = useQuery(accountsQuery)
  const range = search.from && search.to ? { from: search.from, to: search.to } : null
  const backwards = range !== null && range.from > range.to
  const selected = accounts.data && (search.account === undefined ? accounts.data : accounts.data.filter((a) => a.id === search.account))
  const ready = range !== null && !backwards && selected !== undefined && selected.length > 0
  const balances = useQuery({ ...reportBalancesQuery(selected ?? [], range?.from ?? '', range?.to ?? ''), enabled: ready })

  if (accounts.error) return <p role="alert">Fernledger couldn't load the Accounts. Reload the page to try again.</p>
  if (range === null) return <Needs message="Choose the first and last dates this Report covers." />
  if (backwards) return <Needs alert message="The “To” date is before the “From” date. Change one of them to open the Report." />
  if (!selected) return <p role="status">Loading…</p>
  if (selected.length === 0) {
    return accounts.data!.length === 0 ? (
      <>
        <h1 className="text-2xl font-semibold">{NAME}</h1>
        <p className="mt-2">There are no Accounts yet, so there are no balances. An Account is added the first time the Admin imports a file for it.</p>
      </>
    ) : (
      <Needs alert message="There is no such Account. Choose one below." />
    )
  }
  if (balances.error) return <p role="alert">Fernledger couldn't load this Report. Reload the page to try again.</p>
  if (!balances.data) return <p role="status">Loading…</p>

  const labels = selected.map(accountLabel).join('; ')
  return (
    <ReportFrame
      name={NAME}
      accounts={search.account === undefined ? `All Accounts: ${labels}` : labels}
      accountsInTitle={search.account === undefined ? 'All Accounts' : selected[0]!.name}
      from={range.from}
      to={range.to}
      generatedAt={balances.dataUpdatedAt}
    >
      <BalancesOverTime sections={balances.data} />
      <p className="mt-8 print:hidden">
        <Link to="/reports" className="underline underline-offset-4">
          Back to Reports
        </Link>
      </p>
    </ReportFrame>
  )
}
