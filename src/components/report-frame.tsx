import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { HelpSheet } from '@/components/help-sheet'
import { LiveStatus } from '@/components/live-status'
import { PrintReportButton, useReportPrint, useReportScroll, useShownReport } from '@/components/report-gate'
import { api } from '@/lib/api'
import { keepRequest } from '@/lib/kept-reports'
import { HttpError, meQuery } from '@/lib/me'
import { takePrintRequest } from '@/lib/print-request'
import { describeRange, generatedLine, reportHeading } from '@/lib/report-frame'
import { settingsQuery } from '@/lib/settings'

/** What a Report says about itself, for the parts of it that repeat the title block on every printed page (see `useReportIdentity`). */
type ReportIdentity = { appTitle: string; name: string; range: string; generated: string }
const Identity = createContext<ReportIdentity | null>(null)

/**
 * What a Report says about its figures that a reader reads once: what is counted, how a figure is worked out, what is left out. `title` is "About these figures" ("About these
 * balances" for Balances) and `body` is its paragraphs (plain `<p>`s). It is written once and shown twice (`ReportFrame`'s `notes`): on screen in a sheet behind the "?" beside the
 * Report's title, so the figures are not pushed down the page by it, and on paper as a section before the figures, because a printout has no "?". The Report's component exports its
 * notes (a constant) and its route passes them to the frame.
 */
export type ReportNotes = { title: string; body: ReactNode }

/**
 * The heading to give each printed table (`ResponsiveTable`'s `printHeading`), for the Account it lists: two lines, "<app> –
 * <Report> – <Account> – <dates>" and "Generated …". A browser repeats a table's heading at the top of every page the
 * table runs onto, so every printed page says what it is and when it was made, in every browser, with no help from page margins.
 * `also` is a third line for what a reader of a loose page must know about the figures, such as what is not counted. Null outside a Report.
 */
export function useReportIdentity() {
  const identity = useContext(Identity)
  return (accounts: string, also?: string) =>
    identity && (
      <>
        <span className="block font-semibold">{reportHeading({ ...identity, accounts })}</span>
        <span className="block">{identity.generated}</span>
        {also && <span className="block">{also}</span>}
      </>
    )
}

/** The Report's notes on paper: a section before the figures, so a printed page can be read on its own. It is not on the screen (`hidden`), where the "?" beside the title has them. */
function PrintedNotes({ notes }: { notes: ReportNotes }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-6 hidden print:mt-4 print:block">
      <h2 id={id} className="text-lg font-semibold print:text-[13pt]">
        {notes.title}
      </h2>
      <div className="[&_p]:mt-1">{notes.body}</div>
    </section>
  )
}

/**
 * The frame every Report is printed in (README: Reports). It writes the Report's own title block, because a printout leaves
 * out the app header and the sidebar, and with them the app title: the app title from Settings, the Report's name, its Account(s) and dates, and
 * "Generated Thu 8 Oct 2026 at 3:42 pm". A Report is shown on its own page, under the form that asked for it, and
 * is all that is printed of that page; it puts what it lists in `children`, as tables (ResponsiveTable with `print:text-[12pt]` and a
 * `printHeading` from `useReportIdentity`) and headings no smaller than 12pt.
 *
 * On paper (src/index.css, `.report-frame`): text is black on white and at least 12pt, table headings repeat on every page,
 * and a row never splits across pages. The two lines that identify the Report come back on every page in every browser, in
 * each table's heading. Page numbers ("Page 2 of 5") sit in the Report's own page margin, which only Chrome and Edge 131 and later
 * draw; other browsers print the Report without them, and number the pages in their own header and footer if the reader turns
 * that on, which the page's help sheet says (`PRINT_HELP`, src/lib/reports.ts).
 *
 * `generatedAt` is when the data arrived. A Report does not say who made it or who opened it.
 */
export function ReportFrame({
  name,
  accounts,
  accountsInTitle,
  from,
  to,
  subject,
  generatedAt,
  notice,
  notes,
  children,
}: {
  /** The Report's name, such as "Transaction listing". */
  name: string
  /** The Account(s) it covers, in words, for the title block: each with its bank number. */
  accounts: string
  /**
   * What goes in the browser's page title where the Account(s) do, which is the name "Save as PDF" suggests: "All Accounts", or the one Account's name, or for the Loans
   * Report the Loans Category (which has no one Account), such as "Loan – Alice" or "All loans".
   */
  accountsInTitle: string
  /** NZ dates, both ends included. A Report that may begin at the first Transaction (Loans) says so by passing `null`, and its dates read "From the first Transaction to …". */
  from: string | null
  to: string
  /** What the Report is about when that is not an Account (the Loans Report's Loans Category), as one more line of the title block: "Loans: Loan – Alice". */
  subject?: { label: string; text: string }
  /** When the data was read, as a timestamp. */
  generatedAt: number
  /** Something the reader must know before the figures, such as "this Report stops at 10,000 Transactions". Printed under the title block. */
  notice?: ReactNode
  /** What a reader reads once about the figures. On screen it is behind a "?" beside the Report's title; on paper it is a section after the `notice` and before the figures. */
  notes?: ReportNotes
  children: ReactNode
}) {
  const settings = useQuery(settingsQuery)
  const me = useQuery(meQuery)
  const appTitle = settings.data?.app_title
  const range = describeRange(from, to)
  const generated = generatedLine(generatedAt)

  // The page's title names the file "Save as PDF" suggests, and it is what a browser's own print header shows.
  const title = appTitle ? reportHeading({ appTitle, name, accounts: accountsInTitle, range }) : undefined
  useEffect(() => {
    if (title === undefined || appTitle === undefined) return
    let cancelled = false
    // The app's header sets the page title to the app title when the Settings arrive, and an effect in a parent runs after its
    // children's, so a Report that appeared in the same moment would lose to it. A microtask runs after every effect of this render.
    queueMicrotask(() => {
      if (!cancelled) document.title = title
    })
    return () => {
      cancelled = true
      // Back to the app title, not to the title this found: when the Settings arrive in the same moment as the Report, this runs before
      // the header has set the app title, so it found index.html's "Fernledger", and the header doesn't set it again (#57).
      document.title = appTitle
    }
  }, [title, appTitle])

  // The Report has arrived (or been read again): if the form asked for it, the page moves to its top, now that the page is long enough to.
  const scroll = useReportScroll()
  useEffect(() => {
    if (scroll.consume()) scroll.show()
  }, [generatedAt, scroll])

  // The Report waits for who is signed in as well as for the app title, though it no longer prints who: the Admin or a Member decides where the Print button is (in the form beside "Show
  // Report", or above a Member's Report), what the live message says ("below the form"), and whether this showing is kept. Without it the button would start above the Report and move.
  const known = me.data !== undefined
  const identity = useMemo(() => (appTitle && known ? { appTitle, name, range, generated } : null), [appTitle, known, name, range, generated])

  // The Report is on the page once it can say what it is. Each time the Admin shows it (it arrives, or is read again) its choices are kept for the Reports page, and updated if they were
  // already (a Member's view is not a showing: the Worker would refuse it). A Report is the choices and not the figures, so this is all that is kept.
  const shown = useShownReport()
  const onPage = identity !== null
  // Tells the page there is a Report to print, so its form can show the button beside "Show Report" (`useReportPrint`); gone when the Report is.
  const print = useReportPrint()
  const { setPrintable } = print
  useEffect(() => {
    if (!onPage) return
    setPrintable(true)
    return () => setPrintable(false)
  }, [onPage, setPrintable])
  const isAdmin = me.data?.role === 'admin'
  const queryClient = useQueryClient()
  const request = useMemo(() => (shown ? keepRequest(shown.report, shown.chosen) : null), [shown])
  const keep = useMutation({
    mutationFn: async (body: NonNullable<typeof request>) => {
      const res = await api['kept-reports'].$post({ json: body })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kept-reports'] }),
  })
  const { mutate: keepReport } = keep
  useEffect(() => {
    if (isAdmin && onPage && request) keepReport(request)
  }, [isAdmin, onPage, request, generatedAt, keepReport])

  // A row of the Reports page asked for this Report to be printed: the print window opens once it is on the page, titled as "Save as PDF" will name the file (the effect above that set the title
  // has run, and a microtask has set it). Two frames later, so the Report has been painted.
  const printing = useRef(false)
  useEffect(() => {
    if (!onPage || !shown || printing.current || !takePrintRequest(window.location, shown.report.choices)) return
    printing.current = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.print()
        printing.current = false
      }),
    )
  }, [onPage, shown])

  // Without the app title the printout would not say what it is, so it waits for it (and for who is signed in, above).
  if (settings.error) return <p role="alert">Fernledger couldn't load the details this Report needs. Reload the page to try again.</p>
  if (identity === null) return <p role="status">Loading…</p>

  return (
    <Identity.Provider value={identity}>
      <div className="print:hidden">
        {/* Said once the Report is there, and again when it is read again: a Report that was asked for on the page above appears under the form, where a screen reader is not
            looking. A new one for each reading (its key), since its words are the same. */}
        <LiveStatus key={generatedAt} message={`${name} Report is ready${isAdmin ? ', below the form' : ''}.`} />
        {keep.isError && (
          <p role="alert" className="mb-6 font-medium text-destructive">
            Fernledger couldn't add this Report to the list on the Reports page, so Members can't open it yet. Show it again to try once more.
          </p>
        )}
      </div>
      {/* The Admin's button is with "Show Report" in the form. A Member has no form, so theirs is here, above the Report. */}
      {!print.inForm && (
        <div className="mb-6 print:hidden">
          <PrintReportButton variant="default" />
        </div>
      )}
      <article aria-label={name} className="report-frame">
        <header>
          <p className="text-lg font-semibold print:text-[14pt]">{appTitle}</p>
          {/* The page's own heading, above the form, is the h1 on screen, so here the name is text (the article's label says it). On paper that heading is not there, and the name is the Report's h1.
              The "?" beside it is the Report's own, for its notes, and is not the page's ("About this page", beside the h1). A printout has the notes as a section instead (below). */}
          <div className="mt-1 flex min-h-11 items-center gap-3 print:hidden">
            <p aria-hidden="true" className="min-w-0 text-2xl font-semibold">
              {name}
            </p>
            {notes && <HelpSheet label={notes.title}>{notes.body}</HelpSheet>}
          </div>
          <h1 className="mt-1 hidden text-2xl font-semibold print:block print:text-[20pt]">
            {name}
          </h1>
          <dl className="mt-3 grid gap-1">
            {/* The space between each term and its details is for copying the text out; the gap does the spacing on the page. */}
            {subject && (
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-semibold">{subject.label}:</dt> <dd>{subject.text}</dd>
              </div>
            )}
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
        {notes && <PrintedNotes notes={notes} />}
        {children}
      </article>
    </Identity.Provider>
  )
}
