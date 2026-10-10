import { Amount } from '@/components/amount'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { formatBalance, formatDate } from '@/lib/format'
import { accountLabel } from '@/lib/report-frame'
import {
  closingLabel,
  describeDifference,
  differencesNote,
  differencesSummary,
  heldNotes,
  openingLabel,
  outlook,
  sourceOf,
  type AccountBalances,
  type MonthBalance,
} from '@/lib/report-balances'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

// One row for each month. The date and the two amounts keep their words whole; the Source, which can be a sentence, is the column
// that gives way.
const columns: Column<MonthBalance>[] = [
  { key: 'date', header: 'Date', className: `${PAPER} whitespace-nowrap [overflow-wrap:normal]`, cell: (row) => formatDate(row.date) },
  { key: 'balance', header: 'Balance', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Amount cents={row.balanceCents} balance /> },
  { key: 'change', header: 'Change', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Amount cents={row.changeCents} /> },
  { key: 'source', header: 'Source', className: PAPER, cell: sourceOf },
]

/** The balance when the dates begin and when they end, and what changed (the API's, not worked out here). They come before the table, so they never end up alone on a last page. */
function OpeningAndClosing({ section }: { section: AccountBalances }) {
  const { report } = section
  return (
    <dl className="mt-3 grid max-w-xl grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 break-inside-avoid">
      <dt>{openingLabel(report)}</dt>
      <dd className="text-end">
        <Amount cents={report.opening!.balanceCents} balance />
      </dd>
      <dt>{closingLabel(report)}</dt>
      <dd className="text-end">
        <Amount cents={report.closing!.balanceCents} balance />
      </dd>
      <dt className="border-t pt-1 font-semibold">Change</dt>
      <dd className="border-t pt-1 text-end">
        <Amount cents={report.changeCents!} />
      </dd>
    </dl>
  )
}

/** The Balance Check differences in the dates, or the sentence that says there are none (never that the bank agrees when nothing was checked). */
function Differences({ section }: { section: AccountBalances }) {
  const { report } = section
  const summary = differencesSummary(report)
  const note = differencesNote(report)
  return (
    // Not a section with a name of its own: every Account has one, and landmarks with the same name are hard to tell apart.
    <div className="mt-6 print:mt-4">
      <h3 className="text-lg font-semibold print:text-[13pt]">Balance Check differences</h3>
      {summary !== null && <p className="mt-1">{summary}</p>}
      {report.differences.length > 0 && (
        <ul className="mt-2 grid gap-3">
          {report.differences.map((difference) => {
            const words = describeDifference(difference)
            return (
              <li key={difference.asOfDate} className="break-inside-avoid rounded-xl border-2 p-3">
                <p>
                  <Status tone="warning">{words.headline}</Status>
                </p>
                <p className="mt-1">{words.found}</p>
                <p className="mt-1">{words.direction}</p>
              </li>
            )
          })}
        </ul>
      )}
      {note !== null && <p className="mt-3">{note}</p>}
    </div>
  )
}

/** An Account: its name and bank number, what its figures are worked out from, the opening and closing balance, a row for each month, and the Balance Check differences. */
function AccountSection({ section }: { section: AccountBalances }) {
  const { report } = section
  const headingId = `account-${section.accountId}`
  const label = accountLabel({ name: section.accountName, accountNumber: section.accountNumber })
  const printHeading = useReportIdentity()(label)
  const what = outlook(report)
  return (
    <section aria-labelledby={headingId} className="mt-8 print:mt-6">
      <h2 id={headingId} className="text-xl font-semibold print:text-[15pt]">
        {section.accountName} <span className="font-normal">({section.accountNumber})</span>
      </h2>
      {what.kind === 'no-balance' && (
        <p className="mt-2 font-semibold">
          No balances can be worked out for this Account. {what.reason}.
        </p>
      )}
      {what.kind === 'before-held' && (
        <p className="mt-2 font-semibold">No balances for these dates. The first date held for this Account is {formatDate(what.heldFrom)}.</p>
      )}
      {what.kind === 'after-held' && (
        <p className="mt-2 font-semibold">No balances for these dates. The last date held for this Account is {formatDate(what.heldTo)}.</p>
      )}
      {what.kind === 'balances' && (
        <>
          <p className="mt-1">
            Worked out from the bank's balance of {formatBalance(report.anchor!.balanceCents)} on {formatDate(report.anchor!.asOfDate)}.
          </p>
          <OpeningAndClosing section={section} />
          {heldNotes(report, section.cutoverDate).map((note) => (
            <p key={note} className="mt-2">
              {note}
            </p>
          ))}
          <div className="mt-4">
            <ResponsiveTable
              caption={`Balances in ${section.accountName}`}
              columns={columns}
              rows={report.rows}
              getRowKey={(row) => row.date}
              className="print:text-[12pt]"
              printHeading={printHeading}
            />
          </div>
        </>
      )}
      <Differences section={section} />
    </section>
  )
}

/** What a reader needs before the figures: how often, where a balance comes from, and what "held" means. */
function AboutBalances() {
  return (
    <section aria-labelledby="about-balances" className="mt-6 print:mt-4">
      <h2 id="about-balances" className="text-lg font-semibold print:text-[13pt]">
        About these balances
      </h2>
      <p className="mt-1">
        Each Account has a row for every month in these dates, with its balance at the end of the month. Above the rows are its balance when the dates begin and when they end.
      </p>
      <p className="mt-1">
        Fernledger works each balance out from the Transactions it holds, starting from the bank's own balance for the Account. They are calculated figures, not balances the bank gave for each
        month-end. A row says “Bank balance” where the bank did give one for that day.
      </p>
      <p className="mt-1">A date is held when Fernledger has a Transaction or a bank balance for the Account on it. There are no balances before the first date held or after the last.</p>
    </section>
  )
}

/** Each Account on its own: the balances Report has no total, because Accounts are held to different dates. */
export function BalancesOverTime({ sections }: { sections: AccountBalances[] }) {
  return (
    <>
      <AboutBalances />
      {sections.map((section) => (
        <AccountSection key={section.accountId} section={section} />
      ))}
    </>
  )
}
