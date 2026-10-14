import { useQuery } from '@tanstack/react-query'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { DashboardCard } from '@/components/summary/dashboard-card'
import { noBalanceReason } from '@/lib/balance-check'
import { formatDate } from '@/lib/format'
import { balancesQuery } from '@/lib/queries'

/** Summary card: the balance of each Account, from its latest bank balance. */
export function BalancesWidget() {
  const { data: accounts, error } = useQuery(balancesQuery)
  return (
    <DashboardCard
      headingId="balances-heading"
      title="Balances"
      span="two-thirds"
      description={accounts && 'Balance as of the last Transaction we hold, worked out from the bank balance in your Imports. It is not a live figure from the bank.'}
    >
      {error ? (
        <p role="alert">Fernledger couldn't load the balances. Reload the page to try again.</p>
      ) : !accounts ? (
        <p role="status">Loading…</p>
      ) : (
        <ResponsiveTable
          caption="Balance of each Account, calculated from the Transactions held"
          rows={accounts}
          getRowKey={(row) => row.accountId}
          emptyMessage="There are no Accounts yet."
          columns={[
            { key: 'account', header: 'Account', cell: (row) => row.accountName },
            {
              key: 'balance',
              header: 'Balance',
              align: 'end',
              cell: (row) =>
                row.balanceCents === null ? (
                  <>
                    <span>Not known yet</span>
                    {row.cutoverDate !== null && <span className="block text-muted-foreground">This Account's balance will come from the bank link once syncing starts.</span>}
                  </>
                ) : (
                  <Amount cents={row.balanceCents} balance />
                ),
            },
            { key: 'asOf', header: 'As of', cell: (row) => (row.asOfDate === null ? noBalanceReason(row.latestStatus) : formatDate(row.asOfDate)) },
          ]}
        />
      )}
    </DashboardCard>
  )
}
