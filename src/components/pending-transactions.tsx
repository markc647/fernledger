import { useQuery } from '@tanstack/react-query'
import { Amount } from '@/components/amount'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { formatDate, formatDateAtTime } from '@/lib/format'
import { pendingTransactionsQuery } from '@/lib/queries'

type Pending = {
  id: number
  accountName: string
  date: string
  description: string
  amountCents: number
  bankType: string | null
  syncedAt: string
}

const columns: Column<Pending>[] = [
  { key: 'date', header: 'Date', className: 'whitespace-nowrap [overflow-wrap:normal]', cell: (row) => formatDate(row.date) },
  { key: 'account', header: 'Account', className: '[overflow-wrap:break-word]', cell: (row) => row.accountName },
  {
    key: 'description',
    header: 'Description',
    cell: (row) => (
      <>
        {row.description}
        {row.bankType !== null && <span className="mt-1 block text-muted-foreground">{row.bankType}</span>}
      </>
    ),
  },
  { key: 'amount', header: 'Amount', align: 'end', className: '[overflow-wrap:normal]', cell: (row) => <Amount cents={row.amountCents} /> },
]

/**
 * The Pending Transactions, above the settled ones on the Transactions page (ticket 29, spec 54, 55, 56).
 *
 * Pending money is what the bank has reported and not settled: it may still change or disappear, so it is marked as pending and
 * counts towards nothing. It is in no Budget, Report or total, which is not a rule applied here but what the table it is kept in
 * means: nothing that adds Transactions up reads it (worker/pending.ts).
 *
 * Nothing is shown when there is none, and nothing when it cannot be read: the settled Transactions below are the page's point,
 * and this must not claim that there is no pending money when it simply could not ask. Every Sync replaces the lot, so the time
 * of the Sync that wrote them is said with them.
 */
export function PendingTransactions() {
  const { data: pending } = useQuery(pendingTransactionsQuery)
  if (!pending || pending.length === 0) return null
  // Every row of one run carries the same instant; the newest is the run that wrote them.
  const syncedAt = pending.map((row) => row.syncedAt).sort().at(-1)!

  return (
    <section aria-labelledby="pending-heading" className="mb-6">
      <h2 id="pending-heading" className="text-xl font-semibold">
        <Status tone="pending">Pending</Status>
      </h2>
      <p className="mt-1 text-muted-foreground">
        Reported by the bank and not settled yet, as at {formatDateAtTime(new Date(Date.parse(syncedAt)))}. These may still change or disappear, so they are in no Budget, Report or
        total. The next Sync replaces them.
      </p>
      <div className="mt-3">
        <ResponsiveTable caption="Pending Transactions, newest first" columns={columns} rows={pending} getRowKey={(row) => row.id} look="in-card" />
      </div>
    </section>
  )
}
