import { Amount } from '@/components/amount'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { formatDate } from '@/lib/format'
import { accountLabel } from '@/lib/report-frame'
import { detailsOf, REPORT_ROW_CAP, type AccountListing, type Listing, type ReportRow } from '@/lib/report-transactions'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

// A page's width is shared out by what each column holds. Dates, Categories and amounts keep their words whole (the page's
// `overflow-wrap: anywhere` would let them shrink to a character wide and split "Uncategorised"), so the Description and Note,
// which can run long, are the columns that give way.
const columns: Column<ReportRow>[] = [
  { key: 'date', header: 'Date', className: `${PAPER} whitespace-nowrap [overflow-wrap:normal]`, cell: (row) => formatDate(row.date) },
  {
    key: 'description',
    header: 'Description',
    className: PAPER,
    // What the bank said about the payment, in a line under the description: an attorney has to show where the money went.
    cell: (row) => {
      const details = detailsOf(row)
      return (
        <>
          {row.description}
          {details.length > 0 && <span className="mt-1 block text-muted-foreground">{details.join(' · ')}</span>}
        </>
      )
    },
  },
  { key: 'category', header: 'Category', className: `${PAPER} [overflow-wrap:break-word]`, cell: (row) => row.categoryName ?? 'Uncategorised' },
  {
    key: 'note',
    header: 'Note',
    className: PAPER,
    cell: (row) =>
      row.note ? (
        <span className="whitespace-pre-line">{row.note}</span>
      ) : (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No Note</span>
        </>
      ),
  },
  { key: 'amount', header: 'Amount', align: 'end', className: `${PAPER} [overflow-wrap:normal]`, cell: (row) => <Amount cents={row.amountCents} showLabel /> },
]

/** What came in, what went out and the difference, in whole cents. Money out is negative, so Net is the plain sum of the two. */
function Totals({ moneyInCents, moneyOutCents, netCents }: { moneyInCents: number; moneyOutCents: number; netCents: number }) {
  return (
    <dl className="mt-3 grid max-w-sm grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 break-inside-avoid">
      <dt>Money in</dt>
      <dd className="text-end">
        <Amount cents={moneyInCents} />
      </dd>
      <dt>Money out</dt>
      <dd className="text-end">
        <Amount cents={moneyOutCents} />
      </dd>
      <dt className="border-t pt-1 font-semibold">Net</dt>
      <dd className="border-t pt-1 text-end">
        <Amount cents={netCents} />
      </dd>
    </dl>
  )
}

const countOf = (count: number) => `${count.toLocaleString('en-NZ')} ${count === 1 ? 'Transaction' : 'Transactions'}`

/**
 * An Account: its name and bank number, how many Transactions, the totals, then the Transactions. The totals come before the table,
 * so they never end up alone on a last page, and a reader sees the sum before the detail. An Account the Report stopped before
 * (the cap) is said to be not listed, never to have nothing in the range.
 */
function AccountSection({ section }: { section: AccountListing }) {
  const headingId = `account-${section.accountId}`
  const printHeading = useReportIdentity()(accountLabel({ name: section.accountName, accountNumber: section.accountNumber }))
  return (
    <section aria-labelledby={headingId} className="mt-8 print:mt-6">
      <h2 id={headingId} className="text-xl font-semibold print:text-[15pt]">
        {section.accountName} <span className="font-normal">({section.accountNumber})</span>
      </h2>
      {section.status === 'not-listed' ? (
        <p className="mt-2 font-semibold">Not listed: this Report stopped before this Account.</p>
      ) : section.rows.length === 0 ? (
        <p className="mt-2">No Transactions in these dates.</p>
      ) : (
        <>
          <p className="mt-1">
            {section.status === 'partial' ? `${countOf(section.rows.length)} listed, oldest first.` : `${countOf(section.rows.length)}, oldest first.`}
          </p>
          {section.status === 'partial' && (
            <p className="mt-1 font-semibold">Partly listed: this Report stopped part way through this Account. The Transactions and totals here are only those listed.</p>
          )}
          <Totals {...section} />
          <div className="mt-4">
            <ResponsiveTable
              caption={`Transactions in ${section.accountName}`}
              columns={columns}
              rows={section.rows}
              getRowKey={(row) => row.id}
              className="print:text-[12pt]"
              printHeading={printHeading}
            />
          </div>
        </>
      )}
    </section>
  )
}

/** Said at the top and again at the end, so a reader who only reads one of them still sees it. */
export function CappedNotice({ alert = false }: { alert?: boolean }) {
  return (
    <p role={alert ? 'alert' : undefined} className="mt-6 border-2 border-foreground p-3 font-semibold break-inside-avoid">
      This Report stops after {REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions. It lists one Account after another, oldest first, so Transactions after that, in this Account or a
      later one, are not listed, and the totals count only what is listed. Choose a shorter range, or one Account, to see the rest.
    </p>
  )
}

/** With more than one Account, the totals of them all first; then each Account's Transactions in the range, with its own totals. */
export function TransactionListing({ listing }: { listing: Listing }) {
  const { sections } = listing
  const all = sections.reduce((sum, s) => ({ moneyInCents: sum.moneyInCents + s.moneyInCents, moneyOutCents: sum.moneyOutCents + s.moneyOutCents, netCents: sum.netCents + s.netCents }), { moneyInCents: 0, moneyOutCents: 0, netCents: 0 })
  return (
    <>
      {sections.length > 1 && (
        <section aria-labelledby="all-accounts-total" className="mt-8 break-inside-avoid print:mt-6">
          <h2 id="all-accounts-total" className="text-xl font-semibold print:text-[15pt]">
            All Accounts
          </h2>
          <p className="mt-1">{countOf(listing.rowCount)} listed.</p>
          <Totals {...all} />
        </section>
      )}
      {sections.map((section) => (
        <AccountSection key={section.accountId} section={section} />
      ))}
      {listing.capped && <CappedNotice />}
    </>
  )
}
