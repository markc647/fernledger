import type { ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { useReportIdentity, type ReportNotes } from '@/components/report-frame'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { formatBalance, formatDate } from '@/lib/format'
import { isUnused, LOANS_ROW_CAP, loanPerson, owedSentence, owedWords, totalLoans, type LoanLine, type LoanSection, type Loans } from '@/lib/report-loans'
import { MONEY_TEXT, PAPER } from '@/lib/utils'

/** What is owed, as an amount with who owes whom in words under it ("$300.00", "Alice owes"). The amount has no sign: the words say which way it is. */
function Owed({ cents, person }: { cents: number; person: string | null }) {
  return (
    // A block, not an inline box, so that a long name wraps to the card or the cell it is in and does not stretch it.
    <span className="flex flex-col items-end text-end">
      <span className={`font-medium ${MONEY_TEXT}`}>{formatBalance(Math.abs(cents))}</span>
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
 * One loan: its Loans Category's name, what was owed before the start date (when there is one), the money out and in, and what is owed on the last date, then its
 * Transactions with what is owed after each. The figures come before the table, so they never end up alone on a last page, and a reader sees the sum before the detail. A loan the
 * Report stopped before (the cap) is said to be not listed, never to have nothing in the dates, and one it stopped in the middle of has no amount owed at the end: the
 * figure for only some of the Transactions would read as the amount owed. A loan nothing has happened on says so plainly.
 */
function LoanSectionView({ section, from, to }: { section: LoanSection; from: string | null; to: string }) {
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
      ) : isUnused(section) ? (
        <p className="mt-2">Nothing has been lent or repaid on this loan up to {formatDate(to)}.</p>
      ) : (
        <>
          <p className="mt-1">
            {section.lines.length === 0 ? 'No Transactions in these dates.' : section.status === 'partial' ? `${countOf(section.lines.length)} listed, oldest first.` : `${countOf(section.lines.length)}, oldest first.`}
          </p>
          {section.status === 'partial' && (
            <p className="mt-1 font-semibold">Partly listed: this Report stopped part way through this loan. The Transactions and figures here are only those listed, and what is owed at the end is not worked out.</p>
          )}
          <dl className="mt-3 grid max-w-md gap-1 break-inside-avoid">
            {from !== null && <Figure term={`Opening balance (before ${formatDate(from)})`}>{owedSentence(person, section.openingOwedCents)}</Figure>}
            <Figure term="Money out">
              <Amount cents={section.moneyOutCents} />
            </Figure>
            <Figure term="Money in">
              <Amount cents={section.moneyInCents} />
            </Figure>
            <Figure term={`Owed on ${formatDate(to)}`} strong>
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

/**
 * What each loan owes on the last date, one line for each, and the two totals: what the Accounts are owed and what they owe, never netted (a person's debt is not paid by
 * another's loan). For a Report of several loans; it comes before them so a reader sees the answer first. A loan the cap stopped says so, and is in neither total.
 */
function LoansSummary({ sections, to }: { sections: LoanSection[]; to: string }) {
  const printHeading = useReportIdentity()('All loans')
  const totals = totalLoans(sections)
  const columns: Column<LoanSection>[] = [
    { key: 'loan', header: 'Loan', className: `${PAPER} [overflow-wrap:break-word]`, cell: (section) => section.name },
    { key: 'owed', header: `Owed on ${formatDate(to)}`, className: PAPER, cell: (section) => (section.owedCents === null ? 'Not worked out' : owedSentence(loanPerson(section.name), section.owedCents)) },
  ]
  return (
    <section aria-labelledby="loans-summary" className="mt-8 print:mt-6">
      <h2 id="loans-summary" className="text-xl font-semibold print:text-[15pt]">
        All loans
      </h2>
      <dl className="mt-3 grid max-w-md gap-1 break-inside-avoid">
        <Figure term="Owed to the Accounts">{formatBalance(totals.owedToCents)}</Figure>
        <Figure term="Owed by the Accounts">{formatBalance(totals.owedByCents)}</Figure>
      </dl>
      {totals.notWorkedOut > 0 && (
        <p className="mt-2 font-semibold">
          These totals leave out {totals.notWorkedOut === 1 ? 'a loan' : `${totals.notWorkedOut} loans`} this Report did not work out, because it stopped before the end of {totals.notWorkedOut === 1 ? 'it' : 'them'}.
        </p>
      )}
      <div className="mt-4">
        <ResponsiveTable caption="What each loan owes" columns={columns} rows={sections} getRowKey={(section) => section.categoryId} className="print:text-[12pt]" printHeading={printHeading} />
      </div>
    </section>
  )
}

/**
 * What a reader needs before the figures: what a loan is here, which way the money owed runs, and how a Transfer counts. The "?" beside the Report's title has it on screen, and a
 * printout has it before the figures (`ReportFrame`), so a printed page can be read on its own.
 */
export const LOANS_NOTES: ReportNotes = {
  title: 'About these figures',
  body: (
    <>
      <p>
        Each loan is a Loans Category, one for each person, named like Loan – Alice. If more money went out than came in, the person owes the difference to the Accounts. If more came in than went
        out, the person is owed it. Loans aren't counted as spending or income, and have no Budget.
      </p>
      <p>
        A Transfer between your own Accounts is lending or repayment only on the half the Admin gives the Category with an Override. Give it to the half in the lender's Account only: the other half stays a
        Transfer, and giving it to both would cancel out.
      </p>
    </>
  ),
}

/** Said at the top and again at the end, so a reader who only reads one of them still sees it. */
export function LoansCappedNotice({ alert = false }: { alert?: boolean }) {
  return (
    <p role={alert ? 'alert' : undefined} className="mt-6 border-2 border-foreground p-3 font-semibold break-inside-avoid">
      This Report stops after {LOANS_ROW_CAP.toLocaleString('en-NZ')} Transactions. It lists one loan after another, oldest first, so Transactions after that, in this loan or a later one, are not
      listed, and what is owed at the end is not worked out for them. Choose a shorter range, or one loan, to see the rest.
    </p>
  )
}

/**
 * Each loan in turn, in the order the Worker gave the Categories (by name), after what the figures are. With several loans, what each owes and the totals come first. When
 * every loan was asked for (`all`), one nothing has happened on is left out of the sections and named once instead, so a Category the Admin has not used yet (the starter
 * Loans Category, say) is not an empty section.
 */
export function LoansReport({ loans, from, to, all }: { loans: Loans; from: string | null; to: string; all: boolean }) {
  const unused = all ? loans.sections.filter(isUnused) : []
  const shown = all ? loans.sections.filter((section) => !isUnused(section)) : loans.sections
  return (
    <>
      {shown.length >= 2 && <LoansSummary sections={shown} to={to} />}
      {shown.map((section) => (
        <LoanSectionView key={section.categoryId} section={section} from={from} to={to} />
      ))}
      {all && shown.length === 0 && <p className="mt-8 font-semibold">Nothing has been lent or repaid on any Loans Category up to {formatDate(to)}.</p>}
      {unused.length > 0 && (
        <p className="mt-8">
          Nothing has been lent or repaid up to {formatDate(to)} on {unused.map((section) => section.name).join(', ')}, so {unused.length === 1 ? 'it is' : 'they are'} not shown.
        </p>
      )}
      {loans.capped && <LoansCappedNotice />}
    </>
  )
}
