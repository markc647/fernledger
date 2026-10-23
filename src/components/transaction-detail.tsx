import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { EditPanel } from '@/components/edit-panel'
import { NotATransfer, TreatAsTransferAgain } from '@/components/not-a-transfer'
import { Button } from '@/components/ui/button'
import { KIND_NOTES } from '@/lib/category-kinds'
import { formatBalance, formatDate, formatDateTime, isMoment } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { transactionQuery } from '@/lib/queries'
import type { DetailOrigin, TransactionSearch } from '@/lib/transaction-search'
import { notTransferSaved, transferExplanation, treatAsTransferAgainSaved } from '@/lib/transfers'

const linkStyle = 'inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** Back to the list the reader came from, with the same order, page and filters. */
function BackLink({ search, origin }: { search: TransactionSearch; origin?: DetailOrigin }) {
  if (origin === 'uncategorised')
    return (
      <Link to="/uncategorised" search={{ sort: search.sort, dir: search.dir, page: search.page }} className={linkStyle}>
        Back to Uncategorised
      </Link>
    )
  return (
    <Link to="/transactions" search={search} className={linkStyle}>
      Back to Transactions
    </Link>
  )
}

/** One labelled fact. The label sits beside the value on a wide screen and above it on a narrow one. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="font-medium">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

// Undefined as well as null: an answer from before a field was sent leaves it undefined, and a field must read as not sent rather than fail the page.
const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== ''

/** What a field Akahu did not send says, in place of a line that would otherwise go missing (A2). */
const NOT_SENT = <span className="text-muted-foreground">Not sent</span>
/** A stored Akahu field as the page shows it: what Akahu sent, or "Not sent". An empty string is nothing sent, as `present` has it. */
const orNotSent = (value: string | null | undefined) => (present(value) ? value : NOT_SENT)
/** A stored moment: the NZ day and time, or, for something Akahu sent that is not a moment, that text as it came, so nothing stored is hidden. */
const momentOrNotSent = (value: string | null | undefined) => (isMoment(value) ? formatDateTime(value) : orNotSent(value))

/**
 * One Transaction in full: what the list shows, and then, under "From the bank", everything that came with it. For a Synced
 * Transaction that is every field Akahu sends, each on a line of its own and the ones Akahu did not send saying "Not sent", so the
 * Transaction can be read against Akahu's own row (A2). An Import has only what a bank file carries, and says what such a file lacks.
 * The description is the one Akahu sent, here as in every list and Report: where Kiwibank wrote the time of an EFTPOS purchase at the end
 * of it, that text stands, and the time it carries is read out separately as the Bank Time. Every Member can read it; the Admin can also set its Override and Note. `back` is the
 * search the reader came from, and `origin` the page, when it wasn't Transactions.
 */
export function TransactionDetail({ id, back, origin }: { id: string; back: TransactionSearch; origin?: DetailOrigin }) {
  const { data: t, error } = useQuery(transactionQuery(id))
  const { data: me } = useQuery(meQuery)
  // Until `me` arrives nobody is the Admin: the edit control fails closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState('')

  // After a save or cancel, focus goes back to the Edit button, which is where it was.
  const edit = useRef<HTMLButtonElement>(null)
  const returning = useRef(false)
  useEffect(() => {
    if (editing || !returning.current) return
    returning.current = false
    edit.current?.focus()
  }, [editing, t])

  // Not a Transfer, and its undo, replace the control that was pressed, so focus goes to the status line that says what happened.
  const status = useRef<HTMLParagraphElement>(null)
  const announcing = useRef(false)
  useEffect(() => {
    if (!announcing.current) return
    announcing.current = false
    status.current?.focus()
  }, [saved, t])

  if (error instanceof HttpError && error.status === 404)
    return (
      <>
        <h1 className="text-2xl font-semibold">Transaction not found</h1>
        <p role="alert" className="mt-2">There is no Transaction with that number. It may have been removed when imported history was replaced.</p>
        <BackLink search={back} origin={origin} />
      </>
    )
  if (error)
    return (
      <>
        <h1 className="text-2xl font-semibold">Transaction</h1>
        <p role="alert" className="mt-2">Fernledger couldn't load this Transaction. Reload the page to try again.</p>
        <BackLink search={back} origin={origin} />
      </>
    )
  if (!t)
    return (
      <>
        <h1 className="text-2xl font-semibold">Transaction</h1>
        <p role="status" className="mt-2">Loading…</p>
      </>
    )

  const imported = t.source === 'import'
  // An Import's reference is a cheque number, so it is not one of the payment details whose absence the sentence below explains.
  const paymentDetails = [t.bankCounterpartyAccount, t.bankCardSuffix, t.bankParticulars, t.bankPaymentCode].some(present)
  const transferNote = transferExplanation(t)

  return (
    <>
      <BackLink search={back} origin={origin} />
      <h1 className="text-2xl font-semibold">Transaction</h1>
      <p className="mt-2">
        {formatDate(t.date)}, {t.description}, <Amount cents={t.amountCents} />
      </p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {saved}
      </p>
      {isAdmin && !editing && (
        <Button
          ref={edit}
          size="touch"
          variant="outline"
          className="mt-2"
          onClick={() => {
            setSaved('')
            setEditing(true)
          }}
        >
          Edit Category and Note
        </Button>
      )}
      {isAdmin && editing && (
        <EditPanel
          row={t}
          className="mt-4 max-w-xl"
          onSaved={(message) => {
            returning.current = true
            setSaved(message ?? 'Saved.')
            setEditing(false)
          }}
          onCancel={() => {
            returning.current = true
            setEditing(false)
          }}
        />
      )}

      <section aria-labelledby="summary-heading" className="mt-6">
        <h2 id="summary-heading" className="text-xl font-semibold">
          Summary
        </h2>
        <dl className="mt-3 grid gap-3">
          <Fact label="Date">{formatDate(t.date)}</Fact>
          <Fact label="Amount">
            <Amount cents={t.amountCents} />
          </Fact>
          <Fact label="Description">{t.description}</Fact>
          <Fact label="Account">{t.accountName}</Fact>
          <Fact label="Category">
            {t.categoryName ?? <span className="text-muted-foreground">{t.transfer === null ? 'Uncategorised' : 'None, as this is a Transfer'}</span>}
            {t.categoryKind !== null && KIND_NOTES[t.categoryKind] !== null && <span className="block text-muted-foreground">{KIND_NOTES[t.categoryKind]}</span>}
            {t.categorySource === 'override' && <span className="block text-muted-foreground">Override: set by the Admin</span>}
          </Fact>
          {transferNote !== null && (
            <Fact label="Transfer">
              {transferNote}
              {t.transferTransactionId !== null && (
                <span className="block">
                  <Link to="/transactions/$id" params={{ id: String(t.transferTransactionId) }} search={{ ...back, origin }} className={linkStyle}>
                    See the matching Transaction
                  </Link>
                </span>
              )}
              {isAdmin && t.canMarkNotTransfer && (
                <NotATransfer
                  id={t.id}
                  transfer={t}
                  onDone={() => {
                    announcing.current = true
                    setSaved(notTransferSaved())
                  }}
                />
              )}
              {isAdmin && t.notTransfer && (
                <TreatAsTransferAgain
                  id={t.id}
                  onDone={(paired) => {
                    announcing.current = true
                    setSaved(treatAsTransferAgainSaved(paired))
                  }}
                />
              )}
            </Fact>
          )}
          <Fact label="Note">{t.note ? <span className="whitespace-pre-line">{t.note}</span> : <span className="text-muted-foreground">No Note</span>}</Fact>
        </dl>
      </section>

      <section aria-labelledby="bank-heading" className="mt-6">
        <h2 id="bank-heading" className="text-xl font-semibold">
          From the bank
        </h2>
        <dl className="mt-3 grid gap-3">
          <Fact label="Source">{t.source === 'sync' ? 'Synced from Akahu' : 'Imported from a bank file'}</Fact>
          {imported ? (
            <>
              {present(t.bankType) && <Fact label="Type">{t.bankType}</Fact>}
              {present(t.bankMemo) && <Fact label="Bank memo">{t.bankMemo}</Fact>}
              {/* A bank file carries no counterparty account or card, but Kiwibank's does carry particulars and a code, and an Import stores them (worker/imports.ts). */}
              {present(t.bankCounterpartyAccount) && <Fact label="Counterparty account">{t.bankCounterpartyAccount}</Fact>}
              {present(t.bankCardSuffix) && <Fact label="Card">Ending {t.bankCardSuffix}</Fact>}
              {present(t.bankParticulars) && <Fact label="Particulars">{t.bankParticulars}</Fact>}
              {present(t.bankPaymentCode) && <Fact label="Code">{t.bankPaymentCode}</Fact>}
              {present(t.bankReference) && <Fact label="Cheque number">{t.bankReference}</Fact>}
              {t.bankTime !== null && <Fact label="Bank Time">{formatDateTime(t.bankTime)}</Fact>}
              <Fact label="First seen by Akahu">
                {t.firstSeenAt !== null ? formatDateTime(t.firstSeenAt) : "Akahu hasn't reported this Transaction, so there is no first-seen time."}
              </Fact>
            </>
          ) : (
            /* Everything Akahu sent about the Transaction, every field on a line of its own and in the order Akahu's own row reads, so what
               is held can be checked against Akahu (A2). A field Akahu did not send says so rather than going missing. */
            <>
              <Fact label="Akahu ID">{orNotSent(t.akahuId)}</Fact>
              <Fact label="Description">{orNotSent(t.description)}</Fact>
              <Fact label="Merchant">{orNotSent(t.akahuMerchant)}</Fact>
              <Fact label="Type">{orNotSent(t.bankType)}</Fact>
              <Fact label="Bank memo">{orNotSent(t.bankMemo)}</Fact>
              <Fact label="Akahu's category">
                {orNotSent(t.akahuCategoryName)}
                {present(t.akahuCategoryId) && <span className="block text-muted-foreground">Akahu's ID for it: {t.akahuCategoryId}</span>}
                <span className="block text-muted-foreground">
                  {present(t.akahuCategoryGroupName) ? `In Akahu's group ${t.akahuCategoryGroupName}` : "Akahu sent no group for it"}
                  {present(t.akahuCategoryGroupId) ? ` (${t.akahuCategoryGroupId})` : ''}
                </span>
                <span className="block text-muted-foreground">Akahu's own label. It does not set this Transaction's Category.</span>
              </Fact>
              <Fact label="Counterparty account">{orNotSent(t.bankCounterpartyAccount)}</Fact>
              <Fact label="Card">{present(t.bankCardSuffix) ? `Ending ${t.bankCardSuffix}` : NOT_SENT}</Fact>
              <Fact label="Particulars">{orNotSent(t.bankParticulars)}</Fact>
              <Fact label="Code">{orNotSent(t.bankPaymentCode)}</Fact>
              <Fact label="Reference">{orNotSent(t.bankReference)}</Fact>
              <Fact label="Date, as Akahu sent it">{orNotSent(t.akahuDateRaw)}</Fact>
              <Fact label="Posted date">{orNotSent(t.akahuPostedDate)}</Fact>
              {/* The Bank Time is whichever of these two there is; both are kept, so the page says which one it came from. */}
              <Fact label="Akahu's date carried a time">{t.hasBankTime === null || t.hasBankTime === undefined ? NOT_SENT : t.hasBankTime ? 'Yes' : 'No'}</Fact>
              <Fact label="Time read from the description">{momentOrNotSent(t.bankTimeFromMemo)}</Fact>
              <Fact label="Bank Time">{isMoment(t.bankTime) ? formatDateTime(t.bankTime) : NOT_SENT}</Fact>
              <Fact label="Balance after">{typeof t.akahuBalanceCents === 'number' ? formatBalance(t.akahuBalanceCents) : NOT_SENT}</Fact>
              <Fact label="First seen by Akahu">{momentOrNotSent(t.firstSeenAt)}</Fact>
              <Fact label="Last changed at Akahu">{momentOrNotSent(t.akahuUpdatedAt)}</Fact>
              <Fact label="Akahu's hash">{orNotSent(t.akahuHash)}</Fact>
              <Fact label="Akahu's bank connection">{orNotSent(t.akahuConnectionId)}</Fact>
            </>
          )}
        </dl>
        {imported && !paymentDetails && (
          <p className="mt-3 text-muted-foreground">A bank file doesn't include the counterparty account, card, particulars or code, so none is shown.</p>
        )}
      </section>
    </>
  )
}
