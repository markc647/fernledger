import { useQuery } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { MAX_DATE, MIN_DATE, isSearchDate } from '@/lib/date-range'
import { MAX_INCOME_MONTHS, tooManyIncomeMonths } from '@/lib/income-vs-spending'
import { accountsQuery } from '@/lib/queries'
import { MAX_REPORT_MONTHS, tooManyMonths } from '@/lib/report-budget'
import { REPORT_ROW_CAP, type ReportSearch } from '@/lib/report-transactions'

/** What is wrong with the dates, if anything, and the field to mark. `rangeProblem` is a Report's own limit on dates that are in order (Budget vs actual's months). */
function problemWith(from: string, to: string, rangeProblem?: (from: string, to: string) => string | null): { field: 'from' | 'to'; message: string } | null {
  if (from === '') return { field: 'from', message: 'Choose a From date.' }
  if (to === '') return { field: 'to', message: 'Choose a To date.' }
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (!isSearchDate(value)) return { field, message: `The “${field === 'from' ? 'From' : 'To'}” date must be a real date from the year 2000 to 2100.` }
  }
  if (from > to) return { field: 'to', message: 'The “To” date is before the “From” date. Change one of them to open the Report.' }
  const limit = rangeProblem?.(from, to)
  return limit ? { field: 'to', message: limit } : null
}

/** Which Account, or all of them. It is its own component so a form that does not ask for one does not ask the Worker for the Accounts either. */
function AccountField({ id, defaultAccount }: { id: string; defaultAccount: number | undefined }) {
  const accounts = useQuery(accountsQuery)
  const [account, setAccount] = useState(defaultAccount === undefined ? '' : String(defaultAccount))
  return (
    <div>
      <label htmlFor={`${id}-account`} className="block font-medium">
        Account
      </label>
      <Select id={`${id}-account`} name="account" value={account} onChange={(event) => setAccount(event.target.value)}>
        <option value="">All Accounts</option>
        {accounts.data?.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
    </div>
  )
}

/** Says so when the Accounts could not be loaded, under the fields. */
function AccountsError() {
  const accounts = useQuery(accountsQuery)
  return accounts.isError ? (
    <p role="alert" className="mt-3 font-medium text-destructive">
      The Accounts could not be loaded. Reload the page to try again.
    </p>
  ) : null
}

/**
 * Asks which Account (or all of them) and which dates, then opens a Report in a new window. It is a plain form that sends the
 * choice in the Report's address (`?account=2&from=…&to=…`), so it opens in a new window without scripting and the Report can be
 * reopened, bookmarked or sent on from its address. `defaults` fills it in, and `note` says what the Report will hold. Every Report
 * on the Reports page has one, so each names itself (its `aria-label`) and its fields have ids of their own. A Report that is
 * of all Accounts together asks for dates alone (`askAccount={false}`).
 */
function ReportForm({
  name,
  action,
  defaults = {},
  note,
  askAccount = true,
  rangeProblem,
}: {
  name: string
  action: string
  defaults?: ReportSearch
  note: ReactNode
  askAccount?: boolean
  rangeProblem?: (from: string, to: string) => string | null
}) {
  const id = useId()
  const [from, setFrom] = useState(defaults.from ?? '')
  const [to, setTo] = useState(defaults.to ?? '')
  const [problem, setProblem] = useState<ReturnType<typeof problemWith>>(null)

  return (
    <form
      action={action}
      method="get"
      target="_blank"
      rel="noopener"
      aria-label={name}
      noValidate
      onSubmit={(event) => {
        const found = problemWith(from, to, rangeProblem)
        setProblem(found)
        if (found) event.preventDefault()
      }}
    >
      <div className={askAccount ? 'grid gap-4 sm:grid-cols-3' : 'grid gap-4 sm:grid-cols-2'}>
        {askAccount && <AccountField id={id} defaultAccount={defaults.account} />}
        {(['from', 'to'] as const).map((field) => (
          <div key={field}>
            <label htmlFor={`${id}-${field}`} className="block font-medium">
              {field === 'from' ? 'From' : 'To'}
            </label>
            <Input
              id={`${id}-${field}`}
              name={field}
              type="date"
              min={MIN_DATE}
              max={MAX_DATE}
              value={field === 'from' ? from : to}
              aria-invalid={problem?.field === field}
              aria-describedby={problem?.field === field ? `${id}-problem` : undefined}
              onChange={(event) => (field === 'from' ? setFrom : setTo)(event.target.value)}
            />
          </div>
        ))}
      </div>
      {askAccount && <AccountsError />}
      {problem && (
        <p id={`${id}-problem`} role="alert" className="mt-3 font-medium text-destructive">
          {problem.message}
        </p>
      )}
      <p className="mt-4">{note}</p>
      <div className="mt-3">
        {/* The words may wrap: at the largest text size on a phone they are wider than the window. */}
        <Button type="submit" size="touch" className="text-center whitespace-normal">
          Open Report in a new window
        </Button>
      </div>
    </form>
  )
}

/** The Transaction listing Report's form (spec stories 97 to 99). */
export function TransactionListingForm({ defaults }: { defaults?: ReportSearch }) {
  return <ReportForm name="Transaction listing" action="/reports/transactions" defaults={defaults} note={`A Report lists up to ${REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions.`} />
}

/** The spending-by-Category Report's form (spec story 93). */
export function SpendingForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      name="Spending by Category"
      action="/reports/spending"
      defaults={defaults}
      note="A Report has one row for each Category with spending in your dates, the most spent first, and one for Uncategorised when there is any."
    />
  )
}

/** The income-vs-spending-by-month Report's form (spec story 95). */
export function IncomeVsSpendingForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      name="Income vs spending by month"
      action="/reports/income-vs-spending"
      defaults={defaults}
      rangeProblem={tooManyIncomeMonths}
      note={`A Report has one row for each month in your dates, with the income, the spending and the difference between them, and the totals above, up to ${MAX_INCOME_MONTHS} months. Your dates are counted exactly: a month they begin or end part way through counts only those dates, and the row says so.`}
    />
  )
}

/** The balances-over-time Report's form (spec story 96). */
export function BalancesForm({ defaults }: { defaults?: ReportSearch }) {
  return <ReportForm name="Balances over time" action="/reports/balances" defaults={defaults} note="A Report has one balance for the end of each month, with the balance when your dates begin and when they end." />
}

/** The Budget vs actual Report's form (spec story 94): dates only, because a Budget is for all Accounts together. */
export function BudgetVsActualForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      name="Budget vs actual"
      action="/reports/budget-vs-actual"
      defaults={defaults}
      askAccount={false}
      rangeProblem={tooManyMonths}
      note={`A Budget is for a whole month, so a Report shows every month your dates touch, in full, up to ${MAX_REPORT_MONTHS} months. It is of all Accounts together.`}
    />
  )
}
