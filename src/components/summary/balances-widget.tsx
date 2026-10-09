import { useQuery } from '@tanstack/react-query'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { formatDate } from '@/lib/format'
import { balancesQuery } from '@/lib/queries'

/** Why an Account has no balance: a bank balance may exist that the Transactions held don't reach. */
function noBalanceReason(latestStatus: string | null) {
  if (latestStatus === 'after-cutover') return 'The bank balance we have is after the Cutover Date'
  if (latestStatus === 'file-ends-early') return 'The file ended before its bank balance date'
  return 'No bank balance yet'
}

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
        <>
          <p className="mb-3 text-muted-foreground">
            Balance as of the last Transaction we hold, worked out from the bank balance in your Imports. It is not a live figure from the bank.
          </p>
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
        </>
      )}
    </section>
  )
}
