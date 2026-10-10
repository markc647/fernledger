import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { MAX_DATE, MIN_DATE, isSearchDate } from '@/lib/date-range'
import { accountsQuery } from '@/lib/queries'
import { REPORT_ROW_CAP, type ReportSearch } from '@/lib/report-transactions'

/** What is wrong with the dates, if anything, and the field to mark. */
function problemWith(from: string, to: string): { field: 'from' | 'to'; message: string } | null {
  if (from === '') return { field: 'from', message: 'Choose a From date.' }
  if (to === '') return { field: 'to', message: 'Choose a To date.' }
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (!isSearchDate(value)) return { field, message: `The “${field === 'from' ? 'From' : 'To'}” date must be a real date from the year 2000 to 2100.` }
  }
  if (from > to) return { field: 'to', message: 'The “To” date is before the “From” date. Change one of them to open the Report.' }
  return null
}

/**
 * Asks which Account (or all of them) and which dates, then opens the Transaction listing Report in a new window. It is a
 * plain form that sends the choice in the Report's address (`?account=2&from=…&to=…`), so it opens in a new window without
 * scripting and the Report can be reopened, bookmarked or sent on from its address. `defaults` fills it in.
 */
export function TransactionListingForm({ defaults = {} }: { defaults?: ReportSearch }) {
  const accounts = useQuery(accountsQuery)
  const [account, setAccount] = useState(defaults.account === undefined ? '' : String(defaults.account))
  const [from, setFrom] = useState(defaults.from ?? '')
  const [to, setTo] = useState(defaults.to ?? '')
  const [problem, setProblem] = useState<ReturnType<typeof problemWith>>(null)

  return (
    <form
      action="/reports/transactions"
      method="get"
      target="_blank"
      rel="noopener"
      aria-label="Transaction listing"
      noValidate
      onSubmit={(event) => {
        const found = problemWith(from, to)
        setProblem(found)
        if (found) event.preventDefault()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="report-account" className="block font-medium">
            Account
          </label>
          <Select id="report-account" name="account" value={account} onChange={(event) => setAccount(event.target.value)}>
            <option value="">All Accounts</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        {(['from', 'to'] as const).map((field) => (
          <div key={field}>
            <label htmlFor={`report-${field}`} className="block font-medium">
              {field === 'from' ? 'From' : 'To'}
            </label>
            <Input
              id={`report-${field}`}
              name={field}
              type="date"
              min={MIN_DATE}
              max={MAX_DATE}
              value={field === 'from' ? from : to}
              aria-invalid={problem?.field === field}
              aria-describedby={problem?.field === field ? 'report-problem' : undefined}
              onChange={(event) => (field === 'from' ? setFrom : setTo)(event.target.value)}
            />
          </div>
        ))}
      </div>
      {accounts.isError && (
        <p role="alert" className="mt-3 font-medium text-destructive">
          The Accounts could not be loaded. Reload the page to try again.
        </p>
      )}
      {problem && (
        <p id="report-problem" role="alert" className="mt-3 font-medium text-destructive">
          {problem.message}
        </p>
      )}
      <p className="mt-4">A Report lists up to {REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions.</p>
      <div className="mt-3">
        {/* The words may wrap: at the largest text size on a phone they are wider than the window. */}
        <Button type="submit" size="touch" className="text-center whitespace-normal">
          Open Report in a new window
        </Button>
      </div>
    </form>
  )
}
