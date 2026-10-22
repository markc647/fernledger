import { useQuery } from '@tanstack/react-query'
import type { CurrentBalance } from '@/generated/api/balances'
import { Amount } from '@/components/amount'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Status } from '@/components/status'
import { DashboardCard } from '@/components/summary/dashboard-card'
import { SyncStatusLine } from '@/components/summary/sync-status-line'
import { checkedAmount, checkedBy, noBalanceReason, type Checked } from '@/lib/balance-check'
import { featuresQuery } from '@/lib/features'
import { formatDate } from '@/lib/format'
import { balanceChecksQuery, balancesQuery } from '@/lib/queries'

/** The Account's Balance Checks against the bank, in words and an icon (never the colour alone): OK, Check with how far it is out, or a dash ("Not checked" to a screen reader) where its newest bank balance has not been checked. */
function CheckedCell({ checked }: { checked: Checked<{ differenceCents: number }> }) {
  if (checked.kind === 'ok') {
    return (
      <Status tone="success">
        <span>OK</span>
        <span className="sr-only">: agrees with the bank</span>
      </Status>
    )
  }
  if (checked.kind === 'check') {
    return (
      <>
        <Status tone="danger">
          <span>Check</span>
          <span className="sr-only">: balance differs from the bank </span>
        </Status>
        <span className="block text-muted-foreground">{checkedAmount(checked.differences)}</span>
      </>
    )
  }
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not checked</span>
    </>
  )
}

/** What the Balances card's figures are, in the page's help sheet (SummaryHelp): the card itself keeps only the table. */
export const BALANCES_ABOUT =
  'Balance as of the last Transaction we hold, worked out from the latest bank balance: the one in your latest Import, or the one Akahu reported at the last Sync. It is not a live figure from the bank. The Balances over time Report lists each difference and when it began.'

/**
 * Summary card: how current the bank data is (the Sync status, only where Akahu Sync is set up), then the balance of each Account, from its latest bank balance, with a Checked column
 * and, again only when Sync is set up (ADR 0008), a Sync column (README, What it does,
 * says what each shows). The table waits for the Balance Checks and for whether Sync is set up as well as for the balances, so the columns do not appear after the rows. If the checks cannot be read the
 * Checked column is left out and the card says so: a dash would claim that nothing was compared.
 */
export function BalancesWidget() {
  const { data: accounts, error } = useQuery(balancesQuery)
  const checks = useQuery(balanceChecksQuery)
  const features = useQuery(featuresQuery)
  const checkedOf = checks.data ? checkedBy(checks.data) : undefined
  // Not known to be set up while the answer cannot be read: the column is a convenience, and is better left out than shown for a feature that may not be there.
  const syncSetUp = features.data?.some((feature) => feature.id === 'akahu-sync' && feature.enabled) ?? false

  // The page's `overflow-wrap: anywhere` would let a squeezed column shrink to a character wide and split "Account" or "Synced" mid-word, so the short columns keep
  // their words whole and the Balance column, which holds the long "will come from the bank link" line, is the one that gives way.
  const columns: Column<CurrentBalance>[] = [
    { key: 'account', header: 'Account', className: '[overflow-wrap:break-word]', cell: (row) => row.accountName },
    {
      key: 'balance',
      header: 'Balance',
      align: 'end',
      cell: (row) =>
        row.balanceCents === null ? (
          <>
            <span>Not known yet</span>
            {row.linked ? (
              <span className="block text-muted-foreground">Waiting for a balance from Akahu.</span>
            ) : (
              row.cutoverDate !== null && <span className="block text-muted-foreground">This Account's balance will come from the bank link once syncing starts.</span>
            )}
          </>
        ) : (
          <Amount cents={row.balanceCents} balance />
        ),
    },
    { key: 'asOf', header: 'As of', cell: (row) => (row.asOfDate === null ? noBalanceReason(row.latestStatus) : formatDate(row.asOfDate)) },
    ...(checkedOf ? [{ key: 'checked', header: 'Checked', className: '[overflow-wrap:normal]', cell: (row: CurrentBalance) => <CheckedCell checked={checkedOf(row.accountId)} /> }] : []),
    ...(syncSetUp
      ? [
          {
            key: 'sync',
            header: 'Sync',
            className: '[overflow-wrap:normal]',
            cell: (row: CurrentBalance) => (row.syncedInLast24Hours ? <Status tone="success">Synced</Status> : <Status tone="danger">Not Synced</Status>),
          },
        ]
      : []),
  ]

  return (
    <DashboardCard headingId="balances-heading" title="Balances">
      {error ? (
        <p role="alert">Fernledger couldn't load the balances. Reload the page to try again.</p>
      ) : !accounts || checks.isPending || features.isPending ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          {checks.error && (
            <p role="alert" className="mb-3">
              Fernledger couldn't check the balances against the bank. Reload the page to try again.
            </p>
          )}
          {syncSetUp && <SyncStatusLine />}
          <ResponsiveTable
            caption="Balance of each Account, calculated from the Transactions held"
            rows={accounts}
            getRowKey={(row) => row.accountId}
            emptyMessage="There are no Accounts yet."
            columns={columns}
            look="in-card"
          />
        </>
      )}
    </DashboardCard>
  )
}
