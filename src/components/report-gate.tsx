import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { accountsQuery } from '@/lib/queries'
import { accountLabel } from '@/lib/report-frame'
import type { ReportSearch } from '@/lib/report-transactions'

/** An Account as the Reports read it (the Accounts API's). */
export type ReportAccount = { id: number; name: string; accountNumber: string; cutoverDate: string | null }

/** What a Report is given once there is something to read: the Accounts it covers, the dates, and how its title block and page title say the Accounts. */
export type ReportScope = {
  accounts: ReportAccount[]
  /** NZ dates, both ends included, `from` not after `to`. */
  from: string
  to: string
  /** For the title block: each Account with its bank number ("All Accounts: " first when none was chosen). */
  accountsText: string
  /** For the page title, which "Save as PDF" suggests as the file name: "All Accounts", or the one Account's name. */
  accountsInTitle: string
}

/** Not a Report yet: the heading, what is missing, and the form that opens the Report once it is filled in. */
function Needs({ name, form, message, alert = false }: { name: string; form: ReactNode; message: string; alert?: boolean }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">{name}</h1>
      <p role={alert ? 'alert' : 'status'} className="mt-2">
        {message}
      </p>
      <div className="mt-4">{form}</div>
    </>
  )
}

/**
 * Everything a Report's page does before it has anything to read, the same for every Report (CODING_STANDARDS.md, UI): it reads the
 * Accounts, checks the address's dates and Account, and until they are right says what is missing and offers `form`, the Report's own
 * form filled in from the address. Once they are, it gives `children` the scope, and only then does the Report read its data, so a
 * Report's own query runs once it has Accounts and dates to ask about.
 */
export function ReportGate({
  name,
  search,
  form,
  noAccounts,
  children,
}: {
  /** The Report's name, as its heading says it. */
  name: string
  /** What the address holds (parseReportSearch). */
  search: ReportSearch
  form: ReactNode
  /** What to say when no Account has been imported yet, such as "There are no Accounts yet, so there is nothing to list." */
  noAccounts: string
  children: (scope: ReportScope) => ReactNode
}) {
  const accounts = useQuery(accountsQuery)
  if (accounts.error) return <p role="alert">Fernledger couldn't load the Accounts. Reload the page to try again.</p>
  if (!search.from || !search.to) return <Needs name={name} form={form} message="Choose the first and last dates this Report covers." />
  if (search.from > search.to) return <Needs name={name} form={form} alert message="The “To” date is before the “From” date. Change one of them to open the Report." />
  if (!accounts.data) return <p role="status">Loading…</p>
  const selected = search.account === undefined ? accounts.data : accounts.data.filter((a) => a.id === search.account)
  if (selected.length === 0) {
    return accounts.data.length === 0 ? (
      <>
        <h1 className="text-2xl font-semibold">{name}</h1>
        <p className="mt-2">
          {noAccounts} An Account is added the first time the Admin imports a file for it.
        </p>
      </>
    ) : (
      <Needs name={name} form={form} alert message="There is no such Account. Choose one below." />
    )
  }
  const labels = selected.map(accountLabel).join('; ')
  return children({
    accounts: selected,
    from: search.from,
    to: search.to,
    accountsText: search.account === undefined ? `All Accounts: ${labels}` : labels,
    accountsInTitle: search.account === undefined ? 'All Accounts' : selected[0]!.name,
  })
}

/** What a Report says while its data is on the way or could not be read; null once it has arrived. A failed read fails the whole Report, so an incomplete one never looks complete. */
export function reportWaiting(query: { error: unknown; data: unknown }): ReactNode {
  if (query.error) return <p role="alert">Fernledger couldn't load this Report. Reload the page to try again.</p>
  return query.data ? null : <p role="status">Loading…</p>
}

/** The link back to the Reports page, at the foot of a Report on screen (a printout leaves it out). */
export function BackToReports() {
  return (
    <p className="mt-8 print:hidden">
      <Link to="/reports" className="underline underline-offset-4">
        Back to Reports
      </Link>
    </p>
  )
}
