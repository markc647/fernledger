import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Amount } from '@/components/amount'
import { DatePicker } from '@/components/date-picker'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { formatDate } from '@/lib/format'

// Not in the navigation. A reference for the shared display building blocks, built from made-up data, so the browser
// tests (e2e/display.spec.ts) and the accessibility scan exercise each one in both themes and at every text size.
export const Route = createFileRoute('/styleguide')({
  component: Styleguide,
})

const SAMPLE = [
  { id: 1, date: '2026-10-08', description: 'Example Supermarket', cents: -111111 },
  { id: 2, date: '2026-10-05', description: 'Example Employer wages', cents: 123456 },
  { id: 3, date: '2026-09-27', description: 'Example Power Company', cents: -888888 },
]

type SortKey = 'date' | 'description' | 'amount'
type Sample = (typeof SAMPLE)[number]

const SORT_LABELS: Record<SortKey, { ascending: string; descending: string }> = {
  date: { ascending: 'oldest first', descending: 'newest first' },
  description: { ascending: 'A to Z', descending: 'Z to A' },
  amount: { ascending: 'largest money out first', descending: 'largest money in first' },
}
const compare: Record<SortKey, (a: Sample, b: Sample) => number> = {
  date: (a, b) => a.date.localeCompare(b.date),
  description: (a, b) => a.description.localeCompare(b.description),
  amount: (a, b) => a.cents - b.cents,
}

/** Two date pickers on made-up dates, with the date each holds written out as it is stored, which is what a form receives. */
function DateSamples() {
  const [date, setDate] = useState('2026-10-08')
  const [optional, setOptional] = useState('')
  const [bounded, setBounded] = useState('2026-10-15')
  return (
    <div className="date-fields max-w-3xl gap-4">
      <div>
        <label id="sample-date-label" htmlFor="sample-date" className="block font-medium">
          Date
        </label>
        <DatePicker id="sample-date" labelId="sample-date-label" value={date} onChange={setDate} />
        <p className="mt-1 text-muted-foreground">
          The Date is stored as {date}
        </p>
      </div>
      <div>
        <label id="sample-optional-label" htmlFor="sample-optional" className="block font-medium">
          Optional date
        </label>
        <DatePicker id="sample-optional" labelId="sample-optional-label" value={optional} onChange={setOptional} />
        <p className="mt-1 text-muted-foreground">
          The Optional date is stored as {optional || 'nothing'}
        </p>
      </div>
      <div>
        <label id="sample-bounded-label" htmlFor="sample-bounded" className="block font-medium">
          Date from 10 to 20 October 2026
        </label>
        <DatePicker id="sample-bounded" labelId="sample-bounded-label" value={bounded} onChange={setBounded} min="2026-10-10" max="2026-10-20" />
        <p className="mt-1 text-muted-foreground">
          The limited date is stored as {bounded}
        </p>
      </div>
    </div>
  )
}

function Styleguide() {
  // The sample sorts in the browser; the Transactions page asks the server, but the table is the same one.
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ascending' | 'descending' }>({ key: 'date', direction: 'descending' })
  const rows = [...SAMPLE].sort((a, b) => (sort.direction === 'ascending' ? 1 : -1) * compare[sort.key](a, b))
  const sortable = (key: SortKey, first: 'ascending' | 'descending'): Column<Sample>['sort'] => ({
    direction: sort.key === key ? sort.direction : null,
    set: (direction) => setSort({ key, direction }),
    first,
    labels: SORT_LABELS[key],
  })

  return (
    <>
      <h1 className="text-2xl font-semibold">Styleguide</h1>
      <p className="mt-2">
        How amounts, dates, tables and statuses look across Fernledger. The figures here are made up.
      </p>

      <h2 className="mt-8 mb-3 text-xl font-semibold">Transactions</h2>
      <p className="mb-3">Sort by a column heading. On a narrow screen the table becomes cards, and a “Sort by” menu replaces the headings.</p>
      <ResponsiveTable
        caption="Sample transactions"
        rows={rows}
        getRowKey={(row) => row.id}
        columns={[
          { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), sort: sortable('date', 'descending') },
          { key: 'description', header: 'Description', cell: (row) => row.description, sort: sortable('description', 'ascending') },
          { key: 'amount', header: 'Amount', align: 'end', cell: (row) => <Amount cents={row.cents} showLabel />, sort: sortable('amount', 'ascending') },
        ]}
      />

      <h2 className="mt-8 mb-3 text-xl font-semibold">Dates</h2>
      <p className="mb-3">A date is chosen from a calendar. It shows the date as the app writes dates and gives a form the same YYYY-MM-DD text a date field did.</p>
      <DateSamples />

      <h2 className="mt-8 mb-3 text-xl font-semibold">Statuses</h2>
      <ul className="flex flex-wrap gap-x-6 gap-y-3">
        <li>
          <Status tone="success">Synced</Status>
        </li>
        <li>
          <Status tone="pending">Pending</Status>
        </li>
        <li>
          <Status tone="warning">Needs attention</Status>
        </li>
        <li>
          <Status tone="danger">Problem</Status>
        </li>
        <li>
          <Status tone="neutral">Not set up</Status>
        </li>
      </ul>
    </>
  )
}
