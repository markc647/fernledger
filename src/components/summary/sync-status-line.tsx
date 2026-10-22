import { useQuery } from '@tanstack/react-query'
import { Status } from '@/components/status'
import { meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { syncStatus } from '@/lib/sync-status'

/**
 * How current the bank data is, above the Balances table (ticket 29, spec 57, 58, 59, 60): one line everyone reads, the cause
 * under it when something is wrong, and what to do about it for the Admin alone. src/lib/sync-status.ts has the wording and
 * decides the state; this draws it.
 *
 * It shows nothing at all when no Account is linked to Akahu, when the Accounts cannot be read, or while they are still loading:
 * the balances below are the card's point, and a status that cannot be worked out must not claim one. The caller shows it only
 * where Akahu Sync is set up.
 */
export function SyncStatusLine() {
  const { data: accounts } = useQuery(accountsQuery)
  const { data: me } = useQuery(meQuery)
  if (!accounts || !me) return null
  const status = syncStatus(accounts, new Date(), me.role === 'admin' ? 'admin' : 'member')
  if (status === null) return null
  return (
    <div className="mb-3">
      <Status tone={status.tone}>{status.text}</Status>
      {status.cause !== undefined && <p className="mt-1 text-muted-foreground">{status.cause}</p>}
      {status.action !== undefined && <p className="mt-1">{status.action}</p>}
    </div>
  )
}
