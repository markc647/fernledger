import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { MAX_DATE, MIN_DATE, isSearchDate } from '@/lib/date-range'
import { accountsQuery, categoriesQuery } from '@/lib/queries'
import { EXPORT_MAX_ROWS, exportPath, MAX_TEXT, tidy, type TransactionSearch } from '@/lib/transaction-search'

/** What is typed in the form: text for every field, so a half-typed filter is never lost. */
type Draft = { account: string; category: string; from: string; to: string; q: string }

const draftOf = (search: TransactionSearch): Draft => ({
  account: search.account === undefined ? '' : String(search.account),
  category: search.category === undefined ? '' : String(search.category),
  from: search.from ?? '',
  to: search.to ?? '',
  q: search.q ?? '',
})

/** The filters in `draft` as a search, keeping the current sort. Page one, since the results are new. */
const searchOf = (draft: Draft, current: TransactionSearch): TransactionSearch =>
  tidy({
    account: draft.account ? Number(draft.account) : undefined,
    category: draft.category === 'uncategorised' ? 'uncategorised' : draft.category ? Number(draft.category) : undefined,
    from: draft.from,
    to: draft.to,
    q: draft.q.trim(),
    sort: current.sort,
    dir: current.dir,
  })

/** What is wrong with the dates, if anything, and the field to mark. */
function problemWith(draft: Draft): { field: 'from' | 'to'; message: string } | null {
  for (const field of ['from', 'to'] as const) {
    if (draft[field] !== '' && !isSearchDate(draft[field]))
      return { field, message: `The “${field === 'from' ? 'From' : 'To'}” date must be a real date from the year 2000 to 2100.` }
  }
  if (draft.from !== '' && draft.to !== '' && draft.from > draft.to) return { field: 'to', message: 'The “To” date is before the “From” date. Change one of them to search.' }
  return null
}

/**
 * Search and filters for the Transactions: text, Account, Category and a date range. They apply together when the reader
 * presses Search (or Enter), not on every keystroke, so a request is made once the question is asked. The address holds
 * the result, so Back and reload return to it.
 */
export function TransactionFilters({ search, onSearch }: { search: TransactionSearch; onSearch: (search: TransactionSearch) => void }) {
  const accounts = useQuery(accountsQuery)
  const categories = useQuery(categoriesQuery)
  const [draft, setDraft] = useState(draftOf(search))
  const [problem, setProblem] = useState<ReturnType<typeof problemWith>>(null)

  // When the address changes under the form (Back, Forward, a link), show it; a search the form made leaves the draft as it is.
  const applied = JSON.stringify(draftOf(search))
  const [seen, setSeen] = useState(applied)
  if (seen !== applied) {
    setSeen(applied)
    setDraft(draftOf(search))
    setProblem(null)
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const filtered = Object.values(draftOf(search)).some((value) => value !== '')
  // Filters are applied when Search is pressed, not as they are typed, so say so while what is shown is not what is asked for.
  const unapplied = JSON.stringify({ ...draft, q: draft.q.trim() }) !== applied
  // The file holds what the list shows, which is the applied search, so it waits for Search; and a range that runs backwards holds nothing.
  const canDownload = !unapplied && !(search.from && search.to && search.from > search.to)

  return (
    <form
      role="search"
      aria-label="Search Transactions"
      className="mt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const found = problemWith(draft)
        setProblem(found)
        if (!found) onSearch(searchOf(draft, search))
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor="filter-q" className="block font-medium">
            Search
          </label>
          <Input
            id="filter-q"
            name="q"
            type="search"
            autoComplete="off"
            maxLength={MAX_TEXT}
            value={draft.q}
            aria-describedby="filter-q-hint"
            onChange={(event) => set({ q: event.target.value })}
          />
          <p id="filter-q-hint" className="mt-1 text-muted-foreground">
            Finds text in the description, the bank's memo, the Note, and the payment details the bank gave: cheque number or reference, counterparty account,
            particulars, code and card.
          </p>
        </div>
        <div>
          <label htmlFor="filter-account" className="block font-medium">
            Account
          </label>
          <Select id="filter-account" value={draft.account} onChange={(event) => set({ account: event.target.value })}>
            <option value="">All Accounts</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="filter-category" className="block font-medium">
            Category
          </label>
          <Select id="filter-category" value={draft.category} onChange={(event) => set({ category: event.target.value })}>
            <option value="">All Categories</option>
            <option value="uncategorised">Uncategorised</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2 lg:col-span-1">
          {(['from', 'to'] as const).map((field) => (
            <div key={field}>
              <label htmlFor={`filter-${field}`} className="block font-medium">
                {field === 'from' ? 'From' : 'To'}
              </label>
              <Input
                id={`filter-${field}`}
                name={field}
                type="date"
                min={MIN_DATE}
                max={MAX_DATE}
                value={draft[field]}
                aria-invalid={problem?.field === field}
                aria-describedby={problem?.field === field ? 'filter-problem' : undefined}
                onChange={(event) => set({ [field]: event.target.value })}
              />
            </div>
          ))}
        </div>
      </div>
      {(accounts.isError || categories.isError) && (
        <p role="alert" className="mt-3 font-medium text-destructive">
          The Accounts or Categories could not be loaded for the filters. Reload the page to try again.
        </p>
      )}
      {problem && (
        <p id="filter-problem" role="alert" className="mt-3 font-medium text-destructive">
          {problem.message}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="submit" size="touch">
          Search
        </Button>
        {(filtered || Object.values(draft).some((value) => value !== '')) && (
          <Button
            type="button"
            size="touch"
            variant="outline"
            onClick={() => {
              setDraft(draftOf({}))
              setProblem(null)
              onSearch(tidy({ sort: search.sort, dir: search.dir }))
            }}
          >
            Clear filters
          </Button>
        )}
        {canDownload ? (
          <a href={exportPath(search)} download className={buttonVariants({ variant: 'outline', size: 'touch' })} aria-describedby="filter-download-hint">
            Download CSV
          </a>
        ) : (
          <Button type="button" size="touch" variant="outline" disabled aria-describedby="filter-download-hint">
            Download CSV
          </Button>
        )}
      </div>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <div role="status" className="mt-2">
        {unapplied && <p className="text-muted-foreground">Press Search to apply these filters.</p>}
      </div>
      <p id="filter-download-hint" className="mt-2 text-muted-foreground">
        Download CSV saves the Transactions that match the filters you last searched with, oldest first, to open in a spreadsheet. A file holds up to{' '}
        {EXPORT_MAX_ROWS.toLocaleString('en-NZ')} Transactions and says so if more match. Once saved, it is no longer protected by Fernledger's sign-in.
      </p>
    </form>
  )
}
