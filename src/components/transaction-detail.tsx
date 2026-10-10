import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { EditPanel } from '@/components/edit-panel'
import { NotATransfer, TreatAsTransferAgain } from '@/components/not-a-transfer'
import { Button } from '@/components/ui/button'
import { KIND_NOTES } from '@/lib/category-kinds'
import { formatDate, formatDateTime } from '@/lib/format'
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

const present = (value: string | null): value is string => value !== null && value.trim() !== ''

/**
 * One Transaction in full: what the list shows, and everything the bank supplied (the counterparty's account, card,
 * particulars, code and reference), its Bank Time when the bank gave one, and when Akahu first saw it. Every Member can read
 * it; the Admin can also set its Override and Note. `back` is the search the reader came from, and `origin` the page, when it
 * wasn't Transactions.
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

  // An Import's reference is a cheque number. It doesn't stand in for the payment details a bank file lacks, so it doesn't count as one.
  const imported = t.source === 'import'
  const paymentDetails = [t.bankCounterpartyAccount, t.bankCardSuffix, t.bankParticulars, t.bankPaymentCode, imported ? null : t.bankReference].some((value) => value !== null && value.trim() !== '')
  const transferNote = transferExplanation(t)

  return (
    <>
      <BackLink search={back} origin={origin} />
      <h1 className="text-2xl font-semibold">Transaction</h1>
      <p className="mt-2">
        {formatDate(t.date)}, {t.description}, <Amount cents={t.amountCents} />
      </p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
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
            <Amount cents={t.amountCents} showLabel />
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
          {present(t.bankType) && <Fact label="Type">{t.bankType}</Fact>}
          {present(t.bankMemo) && <Fact label="Bank memo">{t.bankMemo}</Fact>}
          {present(t.bankCounterpartyAccount) && <Fact label="Counterparty account">{t.bankCounterpartyAccount}</Fact>}
          {present(t.bankCardSuffix) && <Fact label="Card">Ending {t.bankCardSuffix}</Fact>}
          {present(t.bankParticulars) && <Fact label="Particulars">{t.bankParticulars}</Fact>}
          {present(t.bankPaymentCode) && <Fact label="Code">{t.bankPaymentCode}</Fact>}
          {present(t.bankReference) && <Fact label={imported ? 'Cheque number' : 'Reference'}>{t.bankReference}</Fact>}
          {t.bankTime !== null && <Fact label="Bank Time">{formatDateTime(t.bankTime)}</Fact>}
          {t.firstSeenAt !== null ? (
            <Fact label="First seen by Akahu">{formatDateTime(t.firstSeenAt)}</Fact>
          ) : (
            imported && <Fact label="First seen by Akahu">Akahu hasn't reported this Transaction, so there is no first-seen time.</Fact>
          )}
        </dl>
        {!paymentDetails && (
          <p className="mt-3 text-muted-foreground">
            {t.source === 'sync'
              ? "The bank didn't supply a counterparty account, card, particulars, code or reference for this Transaction."
              : "A bank file doesn't include the counterparty account, card, particulars or code, so none is shown."}
          </p>
        )}
      </section>
    </>
  )
}
