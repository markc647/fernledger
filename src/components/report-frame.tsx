import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { meQuery } from '@/lib/me'
import { describeRange, generatedLine, reportHeading } from '@/lib/report-frame'
import { settingsQuery } from '@/lib/settings'

/** What a Report says about itself, for the parts of it that repeat the title block on every printed page (see `useReportIdentity`). */
type ReportIdentity = { appTitle: string; name: string; range: string; generated: string }
const Identity = createContext<ReportIdentity | null>(null)

/**
 * The heading to give each printed table (`ResponsiveTable`'s `printHeading`), for the Account it lists: two lines, "<app> –
 * <Report> – <Account> – <dates>" and "Generated … by …". A browser repeats a table's heading at the top of every page the
 * table runs onto, so every printed page says what it is and who made it, in every browser, with no help from page margins.
 * Null outside a Report.
 */
export function useReportIdentity() {
  const identity = useContext(Identity)
  return (accounts: string) =>
    identity && (
      <>
        <span className="block font-semibold">{reportHeading({ ...identity, accounts })}</span>
        <span className="block">{identity.generated}</span>
      </>
    )
}

/**
 * The frame every Report is printed in (README: Reports). It writes the Report's own title block, because a printout leaves
 * out the app header and with it the app title: the app title from Settings, the Report's name, its Account(s) and dates, and
 * "Generated Thu 8 Oct 2026 at 3:42 pm by <the signed-in email>". A Report is a page that opens in a new window; it puts what it
 * lists in `children`, as tables (ResponsiveTable with `print:text-[12pt]` and a `printHeading` from `useReportIdentity`) and
 * headings no smaller than 12pt.
 *
 * On paper (src/index.css, `.report-frame`): text is black on white and at least 12pt, table headings repeat on every page,
 * and a row never splits across pages. The two lines that identify the Report come back on every page in every browser, in
 * each table's heading. Page numbers ("Page 2 of 5") sit in the Report's own page margin, which only Chrome and Edge 131 and later
 * draw; other browsers print the Report without them, and number the pages in their own header and footer if the reader turns
 * that on, which the hint on screen says.
 *
 * `generatedAt` is when the data arrived. The email is the signed-in Member's own, from Access; it is printed, never logged.
 */
export function ReportFrame({
  name,
  accounts,
  accountsInTitle,
  from,
  to,
  generatedAt,
  notice,
  children,
}: {
  /** The Report's name, such as "Transaction listing". */
  name: string
  /** The Account(s) it covers, in words, for the title block: each with its bank number. */
  accounts: string
  /** The same for the browser's page title, which is the name "Save as PDF" suggests: "All Accounts", or the one Account's name. */
  accountsInTitle: string
  /** NZ dates, both ends included. */
  from: string
  to: string
  /** When the data was read, as a timestamp. */
  generatedAt: number
  /** Something the reader must know before the figures, such as "this Report stops at 10,000 Transactions". Printed under the title block. */
  notice?: ReactNode
  children: ReactNode
}) {
  const settings = useQuery(settingsQuery)
  const me = useQuery(meQuery)
  const appTitle = settings.data?.app_title
  const email = me.data?.email
  const range = describeRange(from, to)
  const generated = email ? generatedLine(generatedAt, email) : undefined

  // The page's title names the file "Save as PDF" suggests, and it is what a browser's own print header shows.
  const title = appTitle ? reportHeading({ appTitle, name, accounts: accountsInTitle, range }) : undefined
  useEffect(() => {
    if (title === undefined) return
    const before = document.title
    let cancelled = false
    // The app's header sets the page title to the app title when the Settings arrive, and an effect in a parent runs after its
    // children's, so a Report that appeared in the same moment would lose to it. A microtask runs after every effect of this render.
    queueMicrotask(() => {
      if (!cancelled) document.title = title
    })
    return () => {
      cancelled = true
      document.title = before
    }
  }, [title])

  const identity = useMemo(() => (appTitle && generated ? { appTitle, name, range, generated } : null), [appTitle, name, range, generated])

  // Without the app title and who is signed in the printout would not say what it is or who made it, so it waits for both.
  if (settings.error) return <p role="alert">Fernledger couldn't load the details this Report needs. Reload the page to try again.</p>
  if (identity === null) return <p role="status">Loading…</p>

  return (
    <Identity.Provider value={identity}>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
        <Button size="touch" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <p className="min-w-0 flex-1 basis-64">
          In the print window, choose “Save as PDF” to keep a copy. Chrome and Edge (version 131 or later) number the pages (“Page 2 of 5”) themselves. Firefox and
          Safari may need you to turn on the browser's headers and footers in the print dialog.
        </p>
      </div>
      <article aria-labelledby="report-title" className="report-frame">
        <header>
          <p className="text-lg font-semibold print:text-[14pt]">{appTitle}</p>
          <h1 id="report-title" className="mt-1 text-2xl font-semibold print:text-[20pt]">
            {name}
          </h1>
          <dl className="mt-3 grid gap-1">
            {/* The space between each term and its details is for copying the text out; the gap does the spacing on the page. */}
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-semibold">Account:</dt> <dd>{accounts}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-semibold">Dates:</dt> <dd>{range}</dd>
            </div>
          </dl>
          <p className="mt-1">{generated}</p>
        </header>
        {notice}
        {children}
      </article>
    </Identity.Provider>
  )
}
