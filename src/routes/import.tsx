import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { describeBalanceCheck, type BalanceCheckOutcome } from '@/lib/balance-check'
import { adapters, BankCsvError, parseBankCsv, type BankCsvResult } from '@/lib/bank-csv'
import { formatBalance, formatDate } from '@/lib/format'
import { describeCarryBefore, describeLost } from '@/lib/import-carry'
import { countOnOrAfter, DAILY_ROW_WRITES, MAX_IMPORT_ROWS, REPLACE_SLICE, replaceWrites, WRITES_PER_ROW } from '@/lib/import-chunks'
import { describeStop } from '@/lib/import-stop'
import { meQuery } from '@/lib/me'
import { accountsQuery, importedRowsQuery } from '@/lib/queries'
import { ImportStopped, runImport, type ImportSummary } from '@/lib/run-import'

export const Route = createFileRoute('/import')({
  component: ImportScreen,
  staticData: { nav: { label: 'Import', adminOnly: true, order: 20 } },
})

type Step =
  | { name: 'choose'; problem?: string }
  | { name: 'preview'; file: BankCsvResult }
  | { name: 'sending'; sent: number; total: number }
  | { name: 'done'; summary: ImportSummary }
  | { name: 'stopped'; sent: number; total: number; replacing: boolean; removed: number; dailyLimit: boolean }

const PREVIEW_ROWS = 5
const SHOWN_ERRORS = 10

function ImportScreen() {
  // Fails closed: the Import controls appear only once the API has said the visitor is the Admin.
  const { data: me, isPending } = useQuery(meQuery)
  return (
    <>
      <h1 className="text-2xl font-semibold">Import</h1>
      {me?.role === 'admin' ? (
        <ImportFlow />
      ) : isPending ? (
        <p role="status" className="mt-2">
          Checking who you are.
        </p>
      ) : (
        <p className="mt-2">Only the Admin can import files.</p>
      )}
    </>
  )
}

function ImportFlow() {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>({ name: 'choose' })
  const [accountName, setAccountName] = useState('')
  const [setCutover, setSetCutover] = useState(false)
  const [confirmingReplace, setConfirmingReplace] = useState(false)
  const { data: accounts } = useQuery(accountsQuery)

  async function onFile(file: File | undefined) {
    if (!file) return
    try {
      setStep({ name: 'preview', file: parseBankCsv(await file.text()) })
      setAccountName('')
      setSetCutover(false)
      setConfirmingReplace(false)
    } catch (error) {
      // Error messages name a line or field only, never a value from the file.
      setStep({ name: 'choose', problem: error instanceof BankCsvError ? error.message : 'The file could not be read.' })
    }
  }

  async function confirm(file: BankCsvResult, replaceAccountId?: number) {
    setStep({ name: 'sending', sent: 0, total: 1 })
    const replacing = replaceAccountId !== undefined
    try {
      const summary = await runImport(
        file,
        { accountName: accountName.trim() || undefined, cutoverDate: setCutover ? file.dateRange.to : undefined, replaceAccountId },
        (sent, total) => setStep({ name: 'sending', sent, total }),
      )
      setStep({ name: 'done', summary })
    } catch (error) {
      setStep(
        error instanceof ImportStopped
          ? { name: 'stopped', sent: error.sent, total: error.total, replacing, removed: error.removed, dailyLimit: error.dailyLimit }
          : { name: 'stopped', sent: 0, total: 0, replacing, removed: 0, dailyLimit: false },
      )
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      await queryClient.invalidateQueries({ queryKey: ['imported-rows'] })
      await queryClient.invalidateQueries({ queryKey: ['balances'] })
      await queryClient.invalidateQueries({ queryKey: ['balance-checks'] })
    }
  }

  const reset = () => setStep({ name: 'choose' })

  if (step.name === 'choose' || step.name === 'preview') {
    const file = step.name === 'preview' ? step.file : undefined
    const existing = file && accounts?.find((a) => a.accountNumber === file.accountNumber)
    return (
      <div className="mt-4 space-y-6">
        <p>Choose a bank export (a CSV file). Fernledger reads it in your browser and shows you what it found. Nothing is saved until you confirm.</p>
        <div>
          <label htmlFor="bank-file" className="block font-medium">
            Bank export file
          </label>
          <Input
            id="bank-file"
            type="file"
            accept=".csv,text/csv"
            className="mt-1"
            aria-describedby={step.name === 'choose' && step.problem ? 'file-problem' : undefined}
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          {step.name === 'choose' && step.problem && (
            <p id="file-problem" role="alert" className="mt-2 font-medium text-destructive">
              This file is not a supported bank export. {step.problem}
            </p>
          )}
        </div>
        {file && (
          <Preview
            file={file}
            existing={existing || undefined}
            accountName={accountName}
            onAccountName={setAccountName}
            setCutover={setCutover}
            onSetCutover={setSetCutover}
            confirmingReplace={confirmingReplace}
            onConfirmingReplace={setConfirmingReplace}
            onConfirm={() => void confirm(file)}
            onReplace={() => existing && void confirm(file, existing.id)}
            onCancel={reset}
          />
        )}
      </div>
    )
  }

  if (step.name === 'sending') {
    return (
      <p role="status" className="mt-4">
        Importing, part {Math.min(step.sent + 1, step.total)} of {step.total}. Keep this page open.
      </p>
    )
  }

  if (step.name === 'stopped') {
    const { headline, happened, kept, next } = describeStop(step)
    return (
      <div className="mt-4 max-w-xl space-y-4">
        <p role="alert">
          <Status tone="danger">{headline}</Status>
        </p>
        {happened && <p className="font-medium">{happened}</p>}
        {kept && <p>{kept}</p>}
        <p>{next}</p>
        <Button size="touch" onClick={reset}>
          Choose the file again
        </Button>
      </div>
    )
  }

  const lostMessage = describeLost(step.summary.lost)
  return (
    <section className="mt-4 space-y-4" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="text-xl font-semibold">
        Import finished
      </h2>
      <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-2">
        <dt>Added</dt>
        <dd className="text-right tabular-nums">{step.summary.added}</dd>
        <dt>Already held (skipped)</dt>
        <dd className="text-right tabular-nums">{step.summary.duplicates}</dd>
        <dt>Could not be read (skipped)</dt>
        <dd className="text-right tabular-nums">{step.summary.skipped}</dd>
        <dt>On or after the Cutover Date (not imported)</dt>
        <dd className="text-right tabular-nums">{step.summary.dropped}</dd>
        {step.summary.removed > 0 && (
          <>
            <dt>Old imported Transactions removed</dt>
            <dd className="text-right tabular-nums">{step.summary.removed}</dd>
          </>
        )}
        {(step.summary.carried > 0 || step.summary.lost > 0) && (
          <>
            <dt>Transactions that kept their own Category or Note</dt>
            <dd className="text-right tabular-nums">{step.summary.carried}</dd>
            <dt>Categories and Notes lost (no matching Transaction)</dt>
            <dd className="text-right tabular-nums">{step.summary.lost}</dd>
          </>
        )}
      </dl>
      {lostMessage && (
        <p role="status" className="max-w-xl">
          <Status tone="warning">{lostMessage}</Status>
        </p>
      )}
      {step.summary.balanceCheck && <BalanceCheckResult outcome={step.summary.balanceCheck} />}
      <div className="flex flex-wrap gap-2">
        <Link to="/transactions" className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-primary-foreground hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          See the transactions
        </Link>
        <Button size="touch" variant="outline" onClick={reset}>
          Import another file
        </Button>
      </div>
    </section>
  )
}

/** What the Balance Check made of the file's ledger balance. A difference is a warning with the direction in words, never colour alone. */
function BalanceCheckResult({ outcome }: { outcome: BalanceCheckOutcome }) {
  const { tone, headline, detail } = describeBalanceCheck(outcome)
  return (
    <div role="status" className="max-w-xl space-y-1">
      <p>
        <Status tone={tone}>{headline}</Status>
      </p>
      {detail && <p>{detail}</p>}
    </div>
  )
}

function Preview(props: {
  file: BankCsvResult
  existing: { id: number; name: string; cutoverDate: string | null } | undefined
  accountName: string
  onAccountName: (name: string) => void
  setCutover: boolean
  onSetCutover: (set: boolean) => void
  confirmingReplace: boolean
  onConfirmingReplace: (confirming: boolean) => void
  onConfirm: () => void
  onReplace: () => void
  onCancel: () => void
}) {
  const { file, existing } = props
  const existingName = existing?.name
  const adapter = adapters.find((a) => a.id === file.adapterId)
  const count = file.rows.length
  const tooMany = count > MAX_IMPORT_ROWS
  const replaceButton = useRef<HTMLButtonElement>(null)
  // The Cutover Date that will apply to this Import: the one being set, else the Account's own.
  const effectiveCutover = props.setCutover ? file.dateRange.to : (existing?.cutoverDate ?? null)
  // The Worker refuses a replace that would remove the old history and import nothing; the screen says so first.
  const nothingToReplaceWith = count > 0 && countOnOrAfter(file.rows, effectiveCutover) === count
  const firstRows = file.rows.slice(0, PREVIEW_ROWS)
  return (
    <section aria-labelledby="preview-heading" className="space-y-4">
      <h2 id="preview-heading" className="text-xl font-semibold">
        Preview
      </h2>
      <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt>Bank</dt>
        <dd>{adapter?.name ?? file.adapterId}</dd>
        <dt>Account number</dt>
        <dd className="tabular-nums">{file.accountNumber}</dd>
        <dt>Dates</dt>
        <dd>
          {formatDate(file.dateRange.from)} to {formatDate(file.dateRange.to)}
        </dd>
        <dt>Rows</dt>
        <dd>{count} transactions to import</dd>
        <dt>Bank balance</dt>
        <dd>
          <span className="tabular-nums">{formatBalance(file.ledgerBalance.cents)}</span> as of {formatDate(file.ledgerBalance.date)}
        </dd>
      </dl>

      {existingName !== undefined ? (
        <p>Existing Account: {existingName}. These transactions will be added to it.</p>
      ) : (
        <div className="max-w-sm">
          <p>New Account. It will be added when you import.</p>
          <label htmlFor="account-name" className="mt-2 block font-medium">
            Account name
          </label>
          <Input id="account-name" value={props.accountName} maxLength={60} placeholder={file.accountNumber} onChange={(event) => props.onAccountName(event.target.value)} />
          <p className="mt-1 text-sm text-muted-foreground">Optional. You can rename it later.</p>
        </div>
      )}

      <CutoverChoice file={file} accountCutover={existing?.cutoverDate ?? null} effective={effectiveCutover} setCutover={props.setCutover} onSetCutover={props.onSetCutover} />

      {file.errors.length > 0 && (
        <div>
          <p role="status" className="font-medium">
            {file.errors.length} {file.errors.length === 1 ? 'row' : 'rows'} could not be read and will be skipped:
          </p>
          <ul className="mt-1 list-disc ps-6">
            {file.errors.slice(0, SHOWN_ERRORS).map((error) => (
              <li key={error.line}>
                Line {error.line}: {error.message}
              </li>
            ))}
          </ul>
          {file.errors.length > SHOWN_ERRORS && <p className="mt-1">And {file.errors.length - SHOWN_ERRORS} more.</p>}
        </div>
      )}

      {tooMany && (
        <p role="alert" className="font-medium text-destructive">
          This file has {count} transactions, and one Import can take at most {MAX_IMPORT_ROWS}. Export a shorter date range from your bank and import the files one at a time.
        </p>
      )}

      {count > 0 && (
        <ResponsiveTable
          caption={`First ${firstRows.length} rows in the file`}
          rows={firstRows}
          getRowKey={(row) => row.uniqueId}
          columns={[
            { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
            { key: 'description', header: 'Description', cell: (row) => row.payee || row.bankMemo },
            { key: 'amount', header: 'Amount', align: 'end', cell: (row) => <Amount cents={row.amountCents} /> },
          ]}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="touch" disabled={count === 0 || tooMany} onClick={props.onConfirm}>
          Import {count} transactions
        </Button>
        {existing && (
          <Button
            ref={replaceButton}
            size="touch"
            variant="outline"
            className="max-w-full py-2 whitespace-normal"
            disabled={count === 0 || tooMany || nothingToReplaceWith}
            aria-describedby={nothingToReplaceWith ? 'replace-blocked' : undefined}
            onClick={() => props.onConfirmingReplace(true)}
          >
            Replace imported history…
          </Button>
        )}
        <Button size="touch" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {existing && nothingToReplaceWith && (
        <p id="replace-blocked" className="max-w-xl">
          <Status tone="warning">Every row in this file is dated on or after the Cutover Date, so there is nothing to replace the old history with.</Status>
        </p>
      )}

      {existing && props.confirmingReplace && (
        <ReplaceDialog
          account={existing}
          incomingRows={count - countOnOrAfter(file.rows, effectiveCutover)}
          onReplace={props.onReplace}
          onCancel={() => {
            props.onConfirmingReplace(false)
            // The dialog's own button is about to unmount; put focus back where the Admin was rather than on the page.
            replaceButton.current?.focus()
          }}
        />
      )}
    </section>
  )
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-NZ')} ${n === 1 ? one : many}`

/**
 * Asks before replacing an Account's imported history. It opens with the safe answer focused, Escape says no, and it
 * says how many imported Transactions will go. A history of more than REPLACE_SLICE rows goes in final steps, and one
 * too big for a day's database writes (ADR 0004) can't finish today, so the Admin is told that before confirming.
 */
function ReplaceDialog(props: { account: { id: number; name: string }; incomingRows: number; onReplace: () => void; onCancel: () => void }) {
  const { data, isError } = useQuery(importedRowsQuery(props.account.id))
  const imported = data?.imported
  // What the Admin set by hand is carried over to rows with the same bank unique ID; how many don't match is known only afterwards.
  const carryText = describeCarryBefore({ withOwnWork: data?.withOverrideOrNote ?? 0, waiting: data?.carryOverWaiting ?? 0 })
  const keepButton = useRef<HTMLButtonElement>(null)
  useEffect(() => keepButton.current?.focus(), [])
  const inSteps = imported !== undefined && imported > REPLACE_SLICE
  const overOneDay = imported !== undefined && replaceWrites(imported, props.incomingRows) > DAILY_ROW_WRITES
  return (
    <section
      role="alertdialog"
      aria-labelledby="replace-heading"
      aria-describedby="replace-text"
      className="max-w-xl space-y-3 rounded-lg border-2 border-foreground p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onCancel()
      }}
    >
      <h3 id="replace-heading" className="text-lg font-semibold">
        Replace the imported history of {props.account.name}?
      </h3>
      <div id="replace-text" className="space-y-2">
        {isError ? (
          <p>Fernledger couldn't count the imported Transactions, so it can't replace them now. Choose "No" and try again.</p>
        ) : imported === undefined ? (
          <p>Counting the imported Transactions.</p>
        ) : (
          <p>
            {imported === 0
              ? 'There are no imported Transactions to remove, so this just imports the file. '
              : `This removes the ${plural(imported, 'Transaction', 'Transactions')} that ${imported === 1 ? 'was' : 'were'} imported into this Account, then imports this file in its place. `}
            Transactions that came from Sync are not touched. It can't be undone, except by importing the old files again. The Change Log records it.
          </p>
        )}
        {carryText.map((paragraph) => (
          <p key={paragraph} className="font-semibold">
            {paragraph}
          </p>
        ))}
        {inSteps && (
          <p>
            That is more than {REPLACE_SLICE.toLocaleString('en-NZ')}, so the old Transactions are removed in steps of {REPLACE_SLICE.toLocaleString('en-NZ')} before the file is imported. Each step is final: if the
            Import stops part way, the part of the old history already removed can't be put back.{' '}
            {overOneDay
              ? `Removing and importing this many Transactions takes more database writes than the free plan allows in a day (${DAILY_ROW_WRITES.toLocaleString('en-NZ')}). Fernledger stops when the limit is reached, and you choose the same file again tomorrow to finish.`
              : `Each step uses about ${(REPLACE_SLICE * WRITES_PER_ROW).toLocaleString('en-NZ')} of the ${DAILY_ROW_WRITES.toLocaleString('en-NZ')} database writes the free plan allows each day.`}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button ref={keepButton} size="touch" className="max-w-full py-2 whitespace-normal" onClick={props.onCancel}>
          No, keep what is there
        </Button>
        <Button size="touch" variant="outline" className="max-w-full py-2 whitespace-normal" disabled={imported === undefined} onClick={props.onReplace}>
          Yes, replace imported history
        </Button>
      </div>
    </section>
  )
}

/** Tells the Admin what the Account's Cutover Date will do to this file, and offers the file's last date as the Cutover Date. */
function CutoverChoice(props: { file: BankCsvResult; accountCutover: string | null; effective: string | null; setCutover: boolean; onSetCutover: (set: boolean) => void }) {
  const { file, accountCutover, effective } = props
  const dropped = countOnOrAfter(file.rows, effective)
  return (
    <div className="max-w-xl space-y-2">
      {accountCutover !== null && <p>This Account's Cutover Date is {formatDate(accountCutover)}. Rows dated on or after it are not imported.</p>}
      {/* The label is the hit area: the box itself is 20px, but the whole padded row is at least 44px tall. */}
      <label htmlFor="set-cutover" className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
        <input id="set-cutover" type="checkbox" className="mt-0.5 size-5 shrink-0" checked={props.setCutover} onChange={(event) => props.onSetCutover(event.target.checked)} />
        <span>
          {accountCutover === null ? 'Set' : 'Change'} the Cutover Date to the last date in this file, {formatDate(file.dateRange.to)}. Rows dated on or after it are not imported. This is for an Account you'll sync with Akahu; leave it
          unticked otherwise.
        </span>
      </label>
      {effective !== null && (
        <div role="status">
          <Status tone={dropped > 0 ? 'warning' : 'neutral'}>
            {dropped} {dropped === 1 ? 'row' : 'rows'} in this file {dropped === 1 ? 'is' : 'are'} dated on or after {formatDate(effective)} and will not be imported.
          </Status>
        </div>
      )}
    </div>
  )
}
