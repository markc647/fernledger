import { useQuery } from '@tanstack/react-query'
import { Status } from '@/components/status'
import { balanceDiffersMessage, differenceDirection } from '@/lib/balance-check'
import { balanceChecksQuery } from '@/lib/queries'

/**
 * Summary widget: Balance Check warnings, where an Account's Transactions don't add up to the balance the bank gave.
 * When there are none it says so only if some Account has been checked, so it never claims more than it knows.
 */
export function BalanceWarningsWidget() {
  const { data, error } = useQuery(balanceChecksQuery)
  const checked = data?.accounts.some((account) => account.status === 'matched' || account.status === 'differs') ?? false
  return (
    <section aria-labelledby="warnings-heading">
      <h2 id="warnings-heading" className="mb-3 text-xl font-semibold">
        Balance checks
      </h2>
      {error ? (
        <p role="alert">Fernledger couldn't load the balance checks. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status">Loading…</p>
      ) : data.differences.length > 0 ? (
        <ul className="grid gap-3">
          {data.differences.map((difference) => (
            <li key={`${difference.accountId}-${difference.asOfDate}`} className="rounded-xl border bg-card p-4 text-card-foreground">
              <p className="font-medium">{difference.accountName}</p>
              <p className="mt-1">
                <Status tone="warning">{balanceDiffersMessage(difference.differenceCents, difference.since)}</Status>
              </p>
              <p className="mt-1">{differenceDirection(difference.differenceCents)}</p>
            </li>
          ))}
        </ul>
      ) : checked ? (
        <p>
          <Status tone="success">Every checked balance agrees with the bank</Status>
        </p>
      ) : (
        <p>
          <Status tone="neutral">No balance has been checked yet</Status>
        </p>
      )}
    </section>
  )
}
