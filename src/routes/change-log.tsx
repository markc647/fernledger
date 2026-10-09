import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { changeFields } from '@/lib/change-log'
import { formatDateTime } from '@/lib/format'
import { CHANGE_LOG_PAGE_SIZE, changeLogQuery, type ChangeLogFilters } from '@/lib/queries'

export const Route = createFileRoute('/change-log')({
  component: ChangeLog,
  staticData: { nav: { label: 'Change Log', order: 80 } },
})

const NO_FILTERS: ChangeLogFilters = { type: '', from: '', to: '' }

function ChangeLog() {
  const [filters, setFilters] = useState(NO_FILTERS)
  const [page, setPage] = useState(0)
  const backwards = filters.from !== '' && filters.to !== '' && filters.from > filters.to
  const { data, error } = useQuery({ ...changeLogQuery(filters, page), placeholderData: keepPreviousData, enabled: !backwards })
  const filtered = filters.type !== '' || filters.from !== '' || filters.to !== ''
  const typeLabel = (id: string | null) => data?.types.find((t) => t.id === id)?.label ?? 'Other'
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
          <Input id="filter-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => change({ from: event.target.value })} />
        </div>
        <div>
          <label htmlFor="filter-to" className="block font-medium">
            To
          </label>
          <Input id="filter-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => change({ to: event.target.value })} />
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
        <>
          <ol className="mt-4 space-y-4">
            {data.entries.map((entry) => {
              const fields = changeFields(entry.before, entry.after)
              return (
                <li key={entry.id} className="rounded-lg border p-4">
                  <h2 className="text-lg font-semibold">{entry.summary}</h2>
                  <p className="mt-1">
                    <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>. {typeLabel(entry.type)} change by {entry.actor}.
                  </p>
                  {fields.rows.length > 0 && (
                    <div className="mt-3 overflow-x-auto" role="region" aria-label={`Details of: ${entry.summary}`} tabIndex={0}>
                      <table className="w-full text-left">
                        <caption className="sr-only">{`Before and after: ${entry.summary}`}</caption>
                        <thead>
                          <tr className="border-b">
                            <th scope="col" className="py-2 pe-4 font-medium">Field</th>
                            {fields.showBefore && <th scope="col" className="py-2 pe-4 font-medium">Before</th>}
                            {fields.showAfter && <th scope="col" className="py-2 font-medium">After</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {fields.rows.map((row) => (
                            <tr key={row.field} className="border-b last:border-b-0">
                              <th scope="row" className="py-2 pe-4 align-top font-medium">{row.field}</th>
                              {fields.showBefore && <td className="py-2 pe-4 align-top break-words">{row.before}</td>}
                              {fields.showAfter && <td className="py-2 align-top break-words">{row.after}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="touch" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Newer
            </Button>
            <Button size="touch" variant="outline" disabled={(page + 1) * CHANGE_LOG_PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>
              Older
            </Button>
            <span role="status">
              Showing {page * CHANGE_LOG_PAGE_SIZE + 1} to {Math.min((page + 1) * CHANGE_LOG_PAGE_SIZE, data.total)} of {data.total}
            </span>
          </nav>
        </>
      )}
    </>
  )
}
