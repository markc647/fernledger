import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { adapters, BankCsvError, parseBankCsv, type BankCsvResult } from '@/lib/bank-csv'
import { formatDate, formatAmount } from '@/lib/format'
import { MAX_IMPORT_ROWS } from '@/lib/import-chunks'
import { meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
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
  | { name: 'stopped'; sent: number; total: number }

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
  const { data: accounts } = useQuery(accountsQuery)

  async function onFile(file: File | undefined) {
    if (!file) return
    try {
      setStep({ name: 'preview', file: parseBankCsv(await file.text()) })
      setAccountName('')
    } catch (error) {
      // Error messages name a line or field only, never a value from the file.
      setStep({ name: 'choose', problem: error instanceof BankCsvError ? error.message : 'The file could not be read.' })
    }
  }

  async function confirm(file: BankCsvResult) {
    setStep({ name: 'sending', sent: 0, total: 1 })
    try {
      const summary = await runImport(file, accountName.trim() || undefined, (sent, total) => setStep({ name: 'sending', sent, total }))
      setStep({ name: 'done', summary })
    } catch (error) {
      setStep(error instanceof ImportStopped ? { name: 'stopped', sent: error.sent, total: error.total } : { name: 'stopped', sent: 0, total: 0 })
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
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
          <Preview file={file} existingName={existing ? existing.name : undefined} accountName={accountName} onAccountName={setAccountName} onConfirm={() => void confirm(file)} onCancel={reset} />
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
    return (
      <div className="mt-4 space-y-4">
        <p role="alert" className="font-medium text-destructive">
          The Import stopped{step.total > 0 ? ` after ${step.sent} of ${step.total} parts were saved` : ''}.
        </p>
        <p>Nothing is lost. Choose the same file again and import it: rows already saved are recognised and skipped.</p>
        <Button size="touch" onClick={reset}>
          Choose the file again
        </Button>
      </div>
    )
  }

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
      </dl>
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

function Preview(props: {
  file: BankCsvResult
  existingName: string | undefined
  accountName: string
  onAccountName: (name: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { file, existingName } = props
  const adapter = adapters.find((a) => a.id === file.adapterId)
  const count = file.rows.length
  const tooMany = count > MAX_IMPORT_ROWS
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
        <div className="overflow-x-auto" role="region" aria-label="First rows in this file" tabIndex={0}>
          <table className="w-full text-left">
            <caption className="pb-1 text-left text-sm text-muted-foreground">First {Math.min(PREVIEW_ROWS, count)} rows in the file</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pe-4 font-medium">Date</th>
                <th scope="col" className="py-2 pe-4 font-medium">Description</th>
                <th scope="col" className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {file.rows.slice(0, PREVIEW_ROWS).map((row) => (
                <tr key={row.uniqueId} className="border-b">
                  <td className="py-2 pe-4 whitespace-nowrap">{formatDate(row.date)}</td>
                  <td className="py-2 pe-4">{row.payee || row.bankMemo}</td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap">{formatAmount(row.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="touch" disabled={count === 0 || tooMany} onClick={props.onConfirm}>
          Import {count} transactions
        </Button>
        <Button size="touch" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
