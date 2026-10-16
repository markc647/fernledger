import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import { MIN_DATE } from '@/lib/date-range'
import type { Chosen } from '@/lib/kept-reports'
import { HttpError, meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { accountLabel } from '@/lib/report-frame'
import { addressId, type ReportSearch } from '@/lib/report-transactions'
import type { ReportInfo } from '@/lib/reports'

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

const RESULT_ID = 'report-result'

/**
 * What the Report being shown chose: the Report and its address's choices. The Report's frame reads it when the Report is on the page, to keep it for the Reports page (only the Admin
 * makes Reports: worker/kept-reports.ts), and to start the print a row of that page asked for. Nothing outside a Report's page has it.
 */
export type ShownReport = { report: ReportInfo; chosen: Chosen }
const ShownReportContext = createContext<ShownReport | null>(null)
export const useShownReport = () => useContext(ShownReportContext)

/**
 * Moving the page to the Report that was asked for, which on a phone is below the window when the form's button is pressed. The form `request`s it and moves the page at once, to
 * where the Report will be; the Report's frame `consume`s the request when its data arrives, which is when the page is long enough to be moved to the Report's top. A request that
 * is never answered (the Report could not be read) lasts only as long as the page does, which is as long as the form that made it.
 */
type ReportScroll = { request: () => void; show: () => void; consume: () => boolean }
const ReportScrollContext = createContext<ReportScroll>({ request: () => {}, show: () => {}, consume: () => false })
export const useReportScroll = () => useContext(ReportScrollContext)

/**
 * A Report's page: its name, what it holds and its form, and below them the Report itself, or what is missing from one. The name, the words and the form are for the screen; a
 * printout is the Report alone (`print:hidden`), which writes its own title block (ReportFrame).
 */
function ReportPage({ report, form, children }: { report: ReportInfo; form: ReactNode; children: ReactNode }) {
  const requested = useRef(false)
  const scroll = useMemo<ReportScroll>(
    () => ({
      request: () => void (requested.current = true),
      show: () => document.getElementById(RESULT_ID)?.scrollIntoView({ block: 'start' }),
      consume: () => {
        const asked = requested.current
        requested.current = false
        return asked
      },
    }),
    [],
  )
  return (
    <ReportScrollContext.Provider value={scroll}>
      <div className="print:hidden">
        <h1 className="text-2xl font-semibold">{report.name}</h1>
        <p className="mt-2">{report.about}</p>
        {form && <div className="mt-4">{form}</div>}
      </div>
      {/* Always there, so the page has somewhere to move to as soon as a Report is asked for. The space above a Report is padding, not margin, so it moves with the container, and the page stops short of the sticky header (its `scroll-padding-top`) by a little more. On paper the Report starts at the page's own margin. */}
      <div id={RESULT_ID} className={`scroll-mt-4 print:pt-0 ${children ? 'pt-8' : ''}`}>
        {children}
      </div>
    </ReportScrollContext.Provider>
  )
}

/** Not a Report yet: what is missing, said under the form that asks for it. */
export function Needs({ message, alert = false }: { message: string; alert?: boolean }) {
  return <p role={alert ? 'alert' : 'status'}>{message}</p>
}

/**
 * Everything a Report's page does before it has anything to read, the same for every Report (CODING_STANDARDS.md, UI): it writes the page (the Report's name, what it holds and
 * `form`, the Report's own form filled in from the address), reads the Accounts, and checks the address's dates and Account. Until they are right it says, under the form, what is
 * missing. Once they are, it gives `children` the scope, and only then does the Report read its data, so a Report's own query runs once it has Accounts and dates to ask about.
 * An address that chooses nothing (no Account, Category or date: the router takes a blank one, and a date that is not one, out of the address) is a page for choosing: the form, and no complaint that nothing is chosen.
 */
export function ReportGate({
  report,
  search,
  form,
  noAccounts,
  fromOptional = false,
  rangeProblem,
  children,
}: {
  /** The Report (src/lib/reports.ts): its name, as the heading says it, and what it holds, under the heading. */
  report: ReportInfo
  /** What the address holds (parseReportSearch). */
  search: ReportSearch
  form: ReactNode
  /** What to say when no Account has been imported yet, such as "There are no Accounts yet, so there is nothing to list." */
  noAccounts: string
  /** The Report may begin at the first Transaction (Loans): a missing `from` is allowed, and the scope's `from` is then the earliest date a Report accepts (`MIN_DATE`). */
  fromOptional?: boolean
  /** What is wrong with dates that are in order, for this Report alone (such as "too many months"), said with the form like the dates being the wrong way round; null when nothing is. */
  rangeProblem?: (from: string, to: string) => string | null
  children: (scope: ReportScope) => ReactNode
}) {
  const accounts = useQuery(accountsQuery)
  const me = useQuery(meQuery)
  // Only the Admin makes Reports, so only the Admin has the form. Until who is signed in is known nobody is the Admin (the API refuses a Member's Report that has not been kept, whatever the page shows).
  const isAdmin = me.data?.role === 'admin'
  const isMember = me.data !== undefined && !isAdmin
  // What the address chooses, which `search` does not say for a Category (the Loans page gives it only its dates).
  const address = useRouterState({ select: (state) => state.location.search }) as Record<string, unknown>
  const chosen = ['account', 'category', 'from', 'to'].some((key) => address[key] !== undefined && address[key] !== null && address[key] !== '')
  const category = addressId(address.category)
  const shown = useMemo<ShownReport | null>(
    () => (search.to === undefined ? null : { report, chosen: { account: search.account, category, from: search.from, to: search.to } }),
    [report, search.account, category, search.from, search.to],
  )
  const page = (body: ReactNode, withForm = true) => (
    <ReportPage report={report} form={withForm && isAdmin && form}>
      {body}
    </ReportPage>
  )
  // Without the Accounts there is nothing for the form to choose from, so the page says so once and leaves it out.
  if (accounts.error) return page(<p role="alert">Fernledger couldn't load the Accounts. Reload the page to try again.</p>, false)
  const from = search.from ?? (fromOptional ? MIN_DATE : undefined)
  if (!from || !search.to) {
    // A Member has no form to choose with: the Reports page lists the ones the Admin has made.
    if (isMember) return page(<MemberNeeds />)
    return page(chosen ? <Needs message={fromOptional ? 'Choose the last date this Report covers.' : 'Choose the first and last dates this Report covers.'} /> : null)
  }
  if (from > search.to) return page(<NeedsChange message="The “To” date is before the “From” date. Change one of them to show the Report." />)
  const problem = rangeProblem?.(from, search.to)
  if (problem) return page(<NeedsChange message={problem} />)
  if (!accounts.data) return page(<p role="status">Loading…</p>)
  const selected = search.account === undefined ? accounts.data : accounts.data.filter((a) => a.id === search.account)
  if (selected.length === 0) {
    return accounts.data.length === 0 ? (
      page(<Needs message={`${noAccounts} An Account is added the first time the Admin imports a file for it.`} />)
    ) : (
      page(<NeedsChange message="There is no such Account. Choose one in the form above." />)
    )
  }
  const labels = selected.map(accountLabel).join('; ')
  return page(
    <ShownReportContext.Provider value={shown}>
      {children({
        accounts: selected,
        from,
        to: search.to,
        accountsText: search.account === undefined ? `All Accounts: ${labels}` : labels,
        accountsInTitle: search.account === undefined ? 'All Accounts' : selected[0]!.name,
      })}
    </ShownReportContext.Provider>,
  )
}

/**
 * What a Report says when what it was asked for cannot be shown (dates the wrong way round, too many months, an Account or Loans Category that is not there). The Admin is told to
 * change it in the form above. Anyone else has no form, so is told what a Member is on any Report's page that has no Report to show (`MemberNeeds`). Until who is signed in is known nobody is the Admin.
 */
export function NeedsChange({ message }: { message: string }) {
  const me = useQuery(meQuery)
  return me.data?.role === 'admin' ? <Needs alert message={message} /> : <MemberNeeds />
}

/** What a Member is told on a Report's page that has no Report to show: they make none, and the Reports page lists what the Admin has made. */
function MemberNeeds() {
  return (
    <p role="status">
      Only the Admin makes Reports. Open one from the{' '}
      <Link to="/reports" className="underline underline-offset-4">
        list of Reports
      </Link>
      .
    </p>
  )
}

/**
 * What a Report says while its data is on the way or could not be read; null once it has arrived. A failed read fails the whole Report, so an incomplete one never looks complete.
 * A Member who asks for a Report the Admin has not made is refused by the Worker (403), and is told that, and where the Reports that are made are.
 */
export function reportWaiting(query: { error: unknown; data: unknown }): ReactNode {
  if (query.error instanceof HttpError && query.error.status === 403) {
    return (
      <p role="alert">
        The Admin has not made this Report, so it can't be opened. Open one from the{' '}
        <Link to="/reports" className="underline underline-offset-4">
          list of Reports
        </Link>
        .
      </p>
    )
  }
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
