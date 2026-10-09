import { createFileRoute } from '@tanstack/react-router'
import { TransactionDetail } from '@/components/transaction-detail'
import { parseTransactionSearch } from '@/lib/transaction-search'

// `transactions_` opts out of nesting under the Transactions list, so this page replaces it rather than appearing inside it.
// The list passes its own search along, so "Back to Transactions" returns to the same results.
export const Route = createFileRoute('/transactions_/$id')({
  component: Detail,
  validateSearch: parseTransactionSearch,
})

function Detail() {
  const { id } = Route.useParams()
  const back = Route.useSearch()
  return <TransactionDetail id={id} back={back} />
}
