import { useQuery } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { meQuery } from '@/lib/me'
import { cssString, describeRange, generatedLine, runningHead } from '@/lib/report-frame'
import { settingsQuery } from '@/lib/settings'

/**
 * The frame every Report is printed in (README: Reports). It writes the Report's own title block, because a printout leaves
 * out the app header and with it the app title: the app title from Settings, the Report's name, its Account(s) and dates,
 * and "Generated Thu 8 Oct 2026 at 3:42 pm by <the signed-in email>". A Report is a page that opens in a new window; it
 * puts what it lists in `children`, as tables (ResponsiveTable with `print:text-[12pt]`) and headings no smaller than 12pt.
 *
 * On paper (src/index.css, `.report-frame`): text is black on white and at least 12pt, table headings repeat on every page,
 * a row never splits across pages, and the Report's own page margins hold the page numbers ("Page 2 of 5") and, after the
 * first page, a running head and the generated line, so a loose page says what it is and who printed it. Those margin
 * boxes are Chromium's (Chrome, Edge, Opera and Brave 131 and later); Firefox and Safari print the same Report without
 * them, and number the pages themselves in the browser's own header and footer, which the hint on screen points to.
 *
 * `generatedAt` is when the data arrived. The email is the signed-in Member's own, from Access; it is printed, never logged.
 */
export function ReportFrame({
  name,
  accounts,
  from,
  to,
  generatedAt,
  notice,
  children,
}: {
  /** The Report's name, such as "Transaction listing". */
  name: string
  /** The Account(s) it covers, in words: one name, or "All Accounts (…)". */
  accounts: string
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

  // Page margins can only be filled from CSS, so the words travel as custom properties on the document (src/index.css).
  const head = appTitle ? runningHead({ appTitle, name, accounts, range }) : undefined
  const foot = email ? generatedLine(generatedAt, email) : undefined
  useEffect(() => {
    if (head === undefined || foot === undefined) return
    const root = document.documentElement
    root.style.setProperty('--report-head', cssString(head))
    root.style.setProperty('--report-foot', cssString(foot))
    return () => {
      root.style.removeProperty('--report-head')
      root.style.removeProperty('--report-foot')
    }
  }, [head, foot])

  // Without the app title and who is signed in the printout would not say what it is or who made it, so it waits for both.
  if (settings.error) return <p role="alert">Fernledger couldn't load the details this Report needs. Reload the page to try again.</p>
  if (appTitle === undefined || email === undefined) return <p role="status">Loading…</p>

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
        <Button size="touch" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <p className="min-w-0 flex-1 basis-64">
          In the print window, choose “Save as PDF” to keep a copy. If the printout has no page numbers, turn on “Headers and footers” there.
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
          <p className="mt-1">{foot}</p>
        </header>
        {notice}
        {children}
      </article>
    </>
  )
}
