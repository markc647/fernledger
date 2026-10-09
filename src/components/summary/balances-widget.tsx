import { useQuery } from '@tanstack/react-query'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { formatDate } from '@/lib/format'
import { balancesQuery } from '@/lib/queries'

/** Summary widget: the balance of each Account, from its latest bank balance. */
export function BalancesWidget() {
  const { data: accounts, error } = useQuery(balancesQuery)
  return (
    <section aria-labelledby="balances-heading">
      <h2 id="balances-heading" className="mb-3 text-xl font-semibold">
        Balances
      </h2>
      {error ? (
        <p role="alert">Fernledger couldn't load the balances. Reload the page to try again.</p>
      ) : !accounts ? (
        <p role="status">Loading…</p>
      ) : (
        <ResponsiveTable
          caption="Balance of each Account"
          rows={accounts}
          getRowKey={(row) => row.accountId}
          emptyMessage="There are no Accounts yet."
          columns={[
            { key: 'account', header: 'Account', cell: (row) => row.accountName },
            {
              key: 'balance',
              header: 'Balance',
              align: 'end',
              cell: (row) => (row.balanceCents === null ? <span>Not known yet</span> : <Amount cents={row.balanceCents} balance />),
            },
            { key: 'asOf', header: 'As of', cell: (row) => (row.asOfDate === null ? 'No bank balance yet' : formatDate(row.asOfDate)) },
          ]}
        />
      )}
    </section>
  )
}
