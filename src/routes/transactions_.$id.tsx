import { createFileRoute } from '@tanstack/react-router'
import { TransactionDetail } from '@/components/transaction-detail'
import { parseTransactionSearch, type DetailOrigin, type TransactionSearch } from '@/lib/transaction-search'

// `transactions_` opts out of nesting under the Transactions list, so this page replaces it rather than appearing inside it.
// The list passes its own search along, and the page it was opened from if that wasn't Transactions (`origin`), so Back
// returns to the same results.
export const Route = createFileRoute('/transactions_/$id')({
  component: Detail,
  validateSearch: (raw: Record<string, unknown>): TransactionSearch & { origin?: DetailOrigin } => ({
    ...parseTransactionSearch(raw),
    origin: raw.origin === 'uncategorised' ? 'uncategorised' : undefined,
  }),
})

function Detail() {
  const { id } = Route.useParams()
  const { origin, ...back } = Route.useSearch()
  return <TransactionDetail id={id} back={back} origin={origin} />
}
