import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { DatePicker } from '@/components/date-picker'
import { LiveStatus } from '@/components/live-status'
import { useReportScroll } from '@/components/report-gate'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { isLoansKind } from '@/lib/category-kinds'
import { isSearchDate } from '@/lib/date-range'
import { nzDate } from '@/lib/format'
import { MAX_INCOME_MONTHS, tooManyIncomeMonths } from '@/lib/income-vs-spending'
import { accountsQuery, categoriesQuery } from '@/lib/queries'
import { isSameReport, reportHref } from '@/lib/report-address'
import { MAX_REPORT_MONTHS, tooManyMonths } from '@/lib/report-budget'
import type { LoansSearch } from '@/lib/report-loans'
import { REPORT_ROW_CAP, type ReportSearch } from '@/lib/report-transactions'
import { REPORTS, type ReportInfo } from '@/lib/reports'

/** What a Report's form checks about its dates beyond that they are real dates in order. */
type DateRules = {
  /** The Report's own limit on dates that are in order (Budget vs actual's months): what is wrong with them, or null. */
  rangeProblem?: (from: string, to: string) => string | null
  /** The Report can begin at the first Transaction (Loans), so the From date may be left blank. */
  fromOptional?: boolean
}

/** What is wrong with the dates, if anything, and the field to mark. */
function problemWith(from: string, to: string, { rangeProblem, fromOptional = false }: DateRules = {}): { field: 'from' | 'to'; message: string } | null {
  if (from === '' && !fromOptional) return { field: 'from', message: 'Choose a From date.' }
  if (to === '') return { field: 'to', message: 'Choose a To date.' }
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (field === 'from' && value === '') continue
    if (!isSearchDate(value)) return { field, message: `The “${field === 'from' ? 'From' : 'To'}” date must be a real date from the year 2000 to 2100.` }
  }
  if (from !== '' && from > to) return { field: 'to', message: 'The “To” date is before the “From” date. Change one of them to show the Report.' }
  const limit = rangeProblem?.(from, to)
  return limit ? { field: 'to', message: limit } : null
}

/**
 * A field's state, started from `initial` and started again from it whenever `key` changes: the whole address, so that every field of a form starts again together. A form sits
 * above the Report it asked for, so when the address changes without the form (the Back button, say) it shows what the Report below it is of, and not what was last typed.
 */
function useKeyed<T>(initial: T, key: string) {
  const [value, setValue] = useState(initial)
  const [seen, setSeen] = useState(key)
  if (seen !== key) {
    setSeen(key)
    setValue(initial)
  }
  return [value, setValue] as const
}

/** The address a form was filled in from, as one string: what changes whenever any of its fields should start again (`useKeyed`). */
const addressOf = (search: ReportSearch & LoansSearch) => [search.account, search.category, search.from, search.to].join('|')

/** An Account or Category's ID as a select holds it: none, or one that does not exist (0, from an address that named one that is not valid), is the choice of all of them. */
const idOption = (id: number | undefined) => (id ? String(id) : '')

/** Which Account, or all of them. It is its own component so a form that does not ask for one does not ask the Worker for the Accounts either. */
function AccountField({ id, defaultAccount, address }: { id: string; defaultAccount: number | undefined; address: string }) {
  const accounts = useQuery(accountsQuery)
  const [account, setAccount] = useKeyed(idOption(defaultAccount), address)
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

/**
 * Asks which Account (or all of them) and which dates, then shows the Report below it, on the same page. The choice goes in the Report's address (`?account=2&from=…&to=…`),
 * as a plain form would send it, so the Report can be reopened, bookmarked or sent on from its address. `defaults` fills the form in from that address, and `note` says what the
 * Report will hold. Asking again for the Report that is open reads it again: a Report is a snapshot, and says when it was generated. Each Report's page has one, so it names itself
 * (its `aria-label`) and its fields have ids of their own. `report` is the Report (src/lib/reports.ts): its name, its page, and the choices of the address it reads. A Report that is of all Accounts together asks for dates alone (`askAccount={false}`), or for a choice of its own in
 * the Account's place (`chooser`: the Loans Report asks which Loans Category). `fromOptional` lets the From date stay blank, for a Report that can begin at the first Transaction.
 */
function ReportForm({
  report,
  defaults = {},
  note,
  askAccount = true,
  chooser,
  rangeProblem,
  fromOptional,
}: {
  report: ReportInfo
  defaults?: ReportSearch & LoansSearch
  note: ReactNode
  askAccount?: boolean
  chooser?: ReactNode
} & DateRules) {
  const id = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const scroll = useReportScroll()
  const address = addressOf(defaults)
  const [from, setFrom] = useKeyed(defaults.from ?? '', address)
  const [to, setTo] = useKeyed(defaults.to ?? '', address)
  const [problem, setProblem] = useKeyed<ReturnType<typeof problemWith>>(null, address)

  return (
    <form
      aria-label={report.name}
      noValidate
      onSubmit={(event) => {
        event.preventDefault() // the Report is shown on this page, so the router sends the choice and not the browser
        const found = problemWith(from, to, { rangeProblem, fromOptional })
        setProblem(found)
        if (found) return
        const href = reportHref(report.to, new FormData(event.currentTarget))
        // A Report is read when it is asked for, whatever an earlier visit kept: the one that is open, asked for again, is read again (a second press while it is being read does not
        // start another read: that is thousands of rows over the free plan's D1 reads, ADR 0004); any other is read when it is shown.
        void queryClient.invalidateQueries(
          { queryKey: ['reports'], refetchType: isSameReport(href, window.location, report.choices) ? 'active' : 'none' },
          { cancelRefetch: false },
        )
        // The Report appears below the form, which on a phone can be below the window: the page moves to where it will be now, and to its top when it arrives (ReportFrame).
        scroll.request()
        void navigate({ href, resetScroll: false }).then(() => requestAnimationFrame(scroll.show))
      }}
    >
      <div className={askAccount || chooser ? 'grid gap-4 sm:grid-cols-3' : 'grid gap-4 sm:grid-cols-2'}>
        {askAccount && <AccountField id={id} defaultAccount={defaults.account} address={address} />}
        {chooser}
        {(['from', 'to'] as const).map((field) => (
          <div key={field}>
            <label id={`${id}-${field}-label`} htmlFor={`${id}-${field}`} className="block font-medium">
              {field === 'from' ? (fromOptional ? 'From (optional)' : 'From') : 'To'}
            </label>
            <DatePicker
              id={`${id}-${field}`}
              labelId={`${id}-${field}-label`}
              name={field}
              value={field === 'from' ? from : to}
              aria-invalid={problem?.field === field}
              aria-describedby={problem?.field === field ? `${id}-problem` : undefined}
              onChange={field === 'from' ? setFrom : setTo}
            />
          </div>
        ))}
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="mt-3 font-medium text-destructive">
          {problem.message}
        </p>
      )}
      <p className="mt-4">{note}</p>
      <div className="mt-3">
        <Button type="submit" size="touch">
          Show Report
        </Button>
      </div>
    </form>
  )
}

/** The Transaction listing Report's form (spec stories 97 to 99). */
export function TransactionListingForm({ defaults }: { defaults?: ReportSearch }) {
  return <ReportForm report={REPORTS.transactions} defaults={defaults} note={`A Report lists up to ${REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions.`} />
}

/** The spending-by-Category Report's form (spec story 93). */
export function SpendingForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      report={REPORTS.spending}
      defaults={defaults}
      note="A Report has one row for each Category with spending in your dates, the most spent first, and one for Uncategorised when there is any."
    />
  )
}

/** The income-vs-spending-by-month Report's form (spec story 95). */
export function IncomeVsSpendingForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      report={REPORTS.incomeVsSpending}
      defaults={defaults}
      rangeProblem={tooManyIncomeMonths}
      note={`A Report has one row for each month in your dates, with the income, the spending and the difference between them, and the totals above, up to ${MAX_INCOME_MONTHS} months. Your dates are counted exactly: a month they begin or end part way through counts only those dates, and the row says so.`}
    />
  )
}

/** The balances-over-time Report's form (spec story 96). */
export function BalancesForm({ defaults }: { defaults?: ReportSearch }) {
  return <ReportForm report={REPORTS.balances} defaults={defaults} note="A Report has one balance for the end of each month, with the balance when your dates begin and when they end." />
}

/**
 * The Loans Report's form (#38): which Loans Category (or all of them), an optional start date and the date to go up to, which starts at today. It lists the Loans Categories
 * the Admin has made, read from the Categories (the same list the Categories page shows) by kind, so a Category that is not Loans is never offered. A start date left blank
 * begins at the first Transaction. It is for all Accounts together, because a loan is a Category and its Transactions can be in any of them.
 */
export function LoansForm({ defaults }: { defaults?: LoansSearch }) {
  const id = useId()
  const categories = useQuery(categoriesQuery)
  // The same as the form below it fills in from, so the Loan starts again whenever the dates do.
  const shown = { category: defaults?.category, from: defaults?.from, to: defaults?.to ?? nzDate() }
  const [category, setCategory] = useKeyed(idOption(shown.category), addressOf(shown))
  const loans = categories.data?.filter((c) => isLoansKind(c.kind))
  // The list arrives after the form is on the page, so screen readers are told what it holds; a sighted reader sees the choices, or the line about there being none.
  const message = loans === undefined ? '' : loans.length === 0 ? 'There are no Loans Categories yet.' : `${loans.length} ${loans.length === 1 ? 'Loans Category' : 'Loans Categories'} to choose from.`
  return (
    <ReportForm
      report={REPORTS.loans}
      defaults={shown}
      askAccount={false}
      fromOptional
      note="A Report has a section for each Loans Category you choose: its lending and repayments, oldest first, with what is owed after each and on the last date. Name each Category for its person, like “Loan – Alice”: that is how the Report knows who owes whom. Leave From blank to begin at the first Transaction, or choose a date to see what was owed before it."
      chooser={
        <div>
          <label htmlFor={`${id}-category`} className="block font-medium">
            Loan
          </label>
          <Select id={`${id}-category`} name="category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All loans</option>
            {loans?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <LiveStatus message={message} />
          {categories.isError && (
            <p role="alert" className="mt-2 font-medium text-destructive">
              The Categories could not be loaded. Reload the page to try again.
            </p>
          )}
          {loans?.length === 0 && (
            <p className="mt-2">
              There are no Loans Categories yet. The Admin makes one for each person on the{' '}
              <Link to="/categories" className="underline underline-offset-4">
                Categories page
              </Link>
              , named like Loan – Alice, and sets its kind to Loans.
            </p>
          )}
        </div>
      }
    />
  )
}

/** The Budget vs actual Report's form (spec story 94): dates only, because a Budget is for all Accounts together. */
export function BudgetVsActualForm({ defaults }: { defaults?: ReportSearch }) {
  return (
    <ReportForm
      report={REPORTS.budgetVsActual}
      defaults={defaults}
      askAccount={false}
      rangeProblem={tooManyMonths}
      note={`A Budget is for a whole month, so a Report shows every month your dates touch, in full, up to ${MAX_REPORT_MONTHS} months. It is of all Accounts together.`}
    />
  )
}
