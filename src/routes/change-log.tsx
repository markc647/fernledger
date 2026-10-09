import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { changeFields, type ChangeRow } from '@/lib/change-log'
import { formatDateTime } from '@/lib/format'
import { CHANGE_LOG_PAGE_SIZE, changeLogQuery, type ChangeLogFilters } from '@/lib/queries'

export const Route = createFileRoute('/change-log')({
  component: ChangeLog,
  staticData: { nav: { label: 'Change Log', order: 80 } },
})

const NO_FILTERS: ChangeLogFilters = { type: '', from: '', to: '' }

// The range the API accepts. A date input emits partial years (0002, then 0020...) while one is typed; those aren't searched.
const MIN_DATE = '2000-01-01'
const MAX_DATE = '2100-12-31'
const outOfRange = (date: string) => date !== '' && (date < MIN_DATE || date > MAX_DATE)

/** Field, then Before and After where the entry recorded them (an Import has no Before). */
const columnsFor = ({ showBefore, showAfter }: { showBefore: boolean; showAfter: boolean }): Column<ChangeRow>[] => [
  { key: 'field', header: 'Field', cell: (row) => <span className="font-medium">{row.field}</span> },
  ...(showBefore ? [{ key: 'before', header: 'Before', cell: (row: ChangeRow) => <span className="break-words">{row.before}</span> }] : []),
  ...(showAfter ? [{ key: 'after', header: 'After', cell: (row: ChangeRow) => <span className="break-words">{row.after}</span> }] : []),
]

function ChangeLog() {
  const [filters, setFilters] = useState(NO_FILTERS)
  const [page, setPage] = useState(0)
  const backwards = filters.from !== '' && filters.to !== '' && filters.from > filters.to
  const searchable = !backwards && !outOfRange(filters.from) && !outOfRange(filters.to)
  const { data, error, isFetching } = useQuery({ ...changeLogQuery(filters, page), placeholderData: keepPreviousData, enabled: searchable })
  const filtered = filters.type !== '' || filters.from !== '' || filters.to !== ''
  // An entry from before types were recorded has none; it shows no type rather than a made-up one.
  const typeLabel = (id: string | null) => (id === null ? null : (data?.types.find((t) => t.id === id)?.label ?? null))

  // After Older or Newer, the list starts again at its top. If the press left that button disabled (the first or last page)
  // focus would be lost, so it moves to the "Showing …" line, which also announces the new page.
  const results = useRef<HTMLDivElement>(null)
  const summary = useRef<HTMLParagraphElement>(null)
  const paged = useRef(false)
  const lastPage = data !== undefined && (page + 1) * CHANGE_LOG_PAGE_SIZE >= data.total
  useEffect(() => {
    if (!paged.current || isFetching) return // wait for the new page, so what is announced and scrolled to is the new list
    paged.current = false
    results.current?.scrollIntoView({ block: 'start' })
    if (page === 0 || lastPage) summary.current?.focus({ preventScroll: true })
  }, [page, lastPage, isFetching])
  const go = (next: number) => {
    paged.current = true
    setPage(next)
  }
  const change = (patch: Partial<ChangeLogFilters>) => {
    setFilters({ ...filters, ...patch })
    setPage(0)
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Change Log</h1>
      <p className="mt-2">Everything the Admin has changed, newest first.</p>

      <form className="mt-4 flex flex-wrap items-end gap-4" aria-label="Filter the Change Log" onSubmit={(event) => event.preventDefault()}>
        <div>
          <label htmlFor="filter-type" className="block font-medium">
            Type
          </label>
          <select
            id="filter-type"
            value={filters.type}
            onChange={(event) => change({ type: event.target.value })}
            className="block min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
          >
            <option value="">All types</option>
            {data?.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-from" className="block font-medium">
            From
          </label>
          <Input id="filter-from" type="date" value={filters.from} min={MIN_DATE} max={filters.to || MAX_DATE} onChange={(event) => change({ from: event.target.value })} />
        </div>
        <div>
          <label htmlFor="filter-to" className="block font-medium">
            To
          </label>
          <Input id="filter-to" type="date" value={filters.to} min={filters.from || MIN_DATE} max={MAX_DATE} onChange={(event) => change({ to: event.target.value })} />
        </div>
        {filtered && (
          <Button type="button" size="touch" variant="outline" onClick={() => change(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </form>

      {backwards ? (
        <p role="alert" className="mt-4 font-medium">
          The “To” date is before the “From” date. Change one of them to see the Change Log.
        </p>
      ) : error ? (
        <p role="alert" className="mt-4">Fernledger couldn't load the Change Log. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status" className="mt-4">Loading…</p>
      ) : data.total === 0 ? (
        <p role="status" className="mt-4">{filtered ? 'No changes match these filters.' : 'Nothing has been changed yet.'}</p>
      ) : (
        <div ref={results} aria-busy={isFetching} className="mt-4 scroll-mt-4">
          <p ref={summary} role="status" tabIndex={-1} className="mb-4">
            Showing {page * CHANGE_LOG_PAGE_SIZE + 1} to {Math.min((page + 1) * CHANGE_LOG_PAGE_SIZE, data.total)} of {data.total}
          </p>
          <ol className="space-y-4">
            {data.entries.map((entry) => {
              const fields = changeFields(entry.before, entry.after)
              const type = typeLabel(entry.type)
              return (
                <li key={entry.id} className="rounded-lg border p-4">
                  <h2 className="text-lg font-semibold">{entry.summary}</h2>
                  <p className="mt-1">
                    <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>. {type ? `${type} change` : 'Change'} by {entry.actor}.
                  </p>
                  {fields.rows.length > 0 && (
                    <div className="mt-3">
                      <ResponsiveTable
                        caption={`Before and after: ${entry.summary}`}
                        columns={columnsFor(fields)}
                        rows={fields.rows}
                        getRowKey={(row) => row.key}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="touch" variant="outline" disabled={page === 0} onClick={() => go(page - 1)}>
              Newer
            </Button>
            <Button size="touch" variant="outline" disabled={lastPage} onClick={() => go(page + 1)}>
              Older
            </Button>
          </nav>
        </div>
      )}
    </>
  )
}
