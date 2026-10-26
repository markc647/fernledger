import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { PageHeading } from '@/components/help-sheet'
import { TransactionExport } from '@/components/transaction-export'
import { parseExportSearch, type TransactionSearch } from '@/lib/transaction-search'

// The filters are in the address (?account=2&q=cafe&from=2026-01-01), so a reload and Back return to them. The Export page has no list, so no sort or page. Admin and Member alike.
// Its explanation is on the page and not in a "?" sheet: the reader needs it each time, before they save a file.
export const Route = createFileRoute('/export')({
  component: Export,
  validateSearch: parseExportSearch,
  staticData: { nav: { label: 'Export', group: 'transactions', order: 30 } },
})

function Export() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: TransactionSearch) => void navigate({ search: next }), [navigate])

  return (
    <>
      <PageHeading>Export</PageHeading>
      <TransactionExport search={search} onSearch={onSearch} />
    </>
  )
}
