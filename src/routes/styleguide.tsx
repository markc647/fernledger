import { createFileRoute } from '@tanstack/react-router'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
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

function Styleguide() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Styleguide</h1>
      <p className="mt-2">
        How amounts, dates, tables and statuses look across Fernledger. The figures here are made up.
      </p>

      <h2 className="mt-8 mb-3 text-xl font-semibold">Transactions</h2>
      <ResponsiveTable
        caption="Sample transactions"
        rows={SAMPLE}
        getRowKey={(row) => row.id}
        columns={[
          { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
          { key: 'description', header: 'Description', cell: (row) => row.description },
          { key: 'amount', header: 'Amount', align: 'end', cell: (row) => <Amount cents={row.cents} showLabel /> },
        ]}
      />

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
