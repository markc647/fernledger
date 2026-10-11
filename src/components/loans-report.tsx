import type { ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { useReportIdentity } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { formatBalance, formatDate } from '@/lib/format'
import { loanPerson, owedSentence, owedWords, type LoanLine, type LoanSection, type Loans } from '@/lib/report-loans'
import { REPORT_ROW_CAP } from '@/lib/report-transactions'

/** Tighter cells on paper, where a page is 680px wide and a Report is many pages long. */
const PAPER = 'print:px-2 print:py-2'

/** What is owed, as an amount with who owes whom in words under it ("$300.00", "Alice owes"). The amount has no sign: the words say which way it is. */
function Owed({ cents, person }: { cents: number; person: string | null }) {
  return (
    // A block, not an inline box, so that a long name wraps to the card or the cell it is in and does not stretch it.
    <span className="flex flex-col items-end text-end">
      <span className="font-medium whitespace-nowrap tabular-nums [font-kerning:none]">{formatBalance(Math.abs(cents))}</span>
      <span className="text-muted-foreground">{owedWords(person, cents)}</span>
    </span>
  )
}

// A page's width is shared out by what each column holds. Dates and amounts keep their words whole (the page's `overflow-wrap: anywhere` would let them shrink to a
// character wide), so the Description, Account and Note, which can run long, are the columns that give way. On paper they keep at least ten characters, so that a short
// word such as "repayment" is not cut in two to make room; on screen they may shrink further, and a very long word is broken, so that nothing scrolls sideways.
const GIVES_WAY = `${PAPER} print:min-w-[10ch]`
function columnsFor(person: string | null): Column<LoanLine>[] {
  return [
    { key: 'date', header: 'Date', className: `${PAPER} whitespace-nowrap [overflow-wrap:normal]`, cell: (row) => formatDate(row.date) },
    { key: 'description', header: 'Description', className: GIVES_WAY, cell: (row) => row.description },
    // The Account's bank number is not repeated on every row: the title block names each Account with its number.
    { key: 'account', header: 'Account', className: GIVES_WAY, cell: (row) => row.accountName },
    {
      key: 'note',
      header: 'Note',
      className: GIVES_WAY,
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
    { key: 'owed', header: 'Owed after', align: 'end', className: PAPER, cell: (row) => <Owed cents={row.owedAfterCents} person={person} /> },
  ]
}

const countOf = (count: number) => `${count.toLocaleString('en-NZ')} ${count === 1 ? 'Transaction' : 'Transactions'}`

/** One line of a loan's figures: a term and its details, which wrap under each other on a narrow page. */
function Figure({ term, children, strong = false }: { term: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 ${strong ? 'border-t pt-1 font-semibold' : ''}`}>
      <dt>{term}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  )
}

/**
 * One loan: its Loans Category's name, what was owed before the start date (when there is one), the money out and in, and what is owed at the end, then its
 * Transactions with what is owed after each. The figures come before the table, so they never end up alone on a last page, and a reader sees the sum before the detail. A loan the
 * Report stopped before (the cap) is said to be not listed, never to have nothing in the dates, and one it stopped in the middle of has no amount owed at the end: the
 * figure for only some of the Transactions would read as the amount owed.
 */
function LoanSectionView({ section, from }: { section: LoanSection; from: string | undefined }) {
  const headingId = `loan-${section.categoryId}`
  const person = loanPerson(section.name)
  const printHeading = useReportIdentity()(section.name)
  return (
    <section aria-labelledby={headingId} className="mt-8 print:mt-6">
      <h2 id={headingId} className="text-xl font-semibold print:text-[15pt]">
        {section.name}
      </h2>
      {section.status === 'not-listed' ? (
        <p className="mt-2 font-semibold">Not listed: this Report stopped before this loan.</p>
      ) : (
        <>
          <p className="mt-1">
            {section.lines.length === 0 ? 'No Transactions in these dates.' : section.status === 'partial' ? `${countOf(section.lines.length)} listed, oldest first.` : `${countOf(section.lines.length)}, oldest first.`}
          </p>
          {section.status === 'partial' && (
            <p className="mt-1 font-semibold">Partly listed: this Report stopped part way through this loan. The Transactions and figures here are only those listed, and what is owed at the end is not worked out.</p>
          )}
          <dl className="mt-3 grid max-w-md gap-1 break-inside-avoid">
            {from !== undefined && <Figure term={`Opening balance (before ${formatDate(from)})`}>{owedSentence(person, section.openingOwedCents)}</Figure>}
            <Figure term="Money out">
              <Amount cents={section.moneyOutCents} />
            </Figure>
            <Figure term="Money in">
              <Amount cents={section.moneyInCents} />
            </Figure>
            <Figure term="Owed at the end" strong>
              {section.owedCents === null ? 'Not worked out' : owedSentence(person, section.owedCents)}
            </Figure>
          </dl>
          {section.lines.length > 0 && (
            <div className="mt-4">
              <ResponsiveTable
                caption={`Transactions in ${section.name}`}
                columns={columnsFor(person)}
                rows={section.lines}
                getRowKey={(row) => row.id}
                className="print:text-[12pt]"
                printHeading={printHeading}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** What a reader needs before the figures: what a loan is here, and which way the money owed runs. Said before the figures so a printed page can be read on its own. */
function AboutLoans() {
  return (
    <section aria-labelledby="about-loans" className="mt-6 print:mt-4">
      <h2 id="about-loans" className="text-lg font-semibold print:text-[13pt]">
        About these figures
      </h2>
      <p className="mt-1">
        Each loan is a Loans Category, one for each person, such as Loan – Alice. If more money went out than came in, the person owes the difference. If more came in than went out, the person is owed
        it. Loans aren't counted as spending or income, and have no Budget.
      </p>
    </section>
  )
}

/** Said at the top and again at the end, so a reader who only reads one of them still sees it. */
export function LoansCappedNotice({ alert = false }: { alert?: boolean }) {
  return (
    <p role={alert ? 'alert' : undefined} className="mt-6 border-2 border-foreground p-3 font-semibold break-inside-avoid">
      This Report stops after {REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions. It lists one loan after another, oldest first, so Transactions after that, in this loan or a later one, are not
      listed, and what is owed at the end is not worked out for them. Choose a shorter range, or one loan, to see the rest.
    </p>
  )
}

/** Each loan in turn, in the order the Worker gave the Categories (by name), after what the figures are. */
export function LoansReport({ loans, from }: { loans: Loans; from: string | undefined }) {
  return (
    <>
      <AboutLoans />
      {loans.sections.map((section) => (
        <LoanSectionView key={section.categoryId} section={section} from={from} />
      ))}
      {loans.capped && <LoansCappedNotice />}
    </>
  )
}
