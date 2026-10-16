import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { TransactionFilters } from '@/components/transaction-filters'
import { Button, buttonVariants } from '@/components/ui/button'
import { accountsQuery, categoriesQuery, transactionCountQuery } from '@/lib/queries'
import { EXPORT_MAX_ROWS, exportPath, searchProblem, type TransactionSearch } from '@/lib/transaction-search'

/**
 * The Export page's content: what Download CSV saves and what a saved file leaves unprotected, the Transactions' filters, and Download CSV for the Transactions that match what
 * was last searched for (`search`, which the page keeps in its address). The explanation and a warning that a file would stop short are on the page, under its heading, because the
 * reader needs them each time; the warning is in a status region that is always there, so that a screen reader announces it when it appears. The file is of the applied search,
 * so it waits for Search; and a range that runs backwards holds nothing, nor does a search naming an Account or Category that doesn't exist, which the page says (`searchProblem`).
 * The count is in a status region of its own, so a screen reader announces it when a search changes it; if it can't be counted the page says so.
 */
export function TransactionExport({ search, onSearch }: { search: TransactionSearch; onSearch: (search: TransactionSearch) => void }) {
  const accounts = useQuery(accountsQuery)
  const categories = useQuery(categoriesQuery)
  const problem = searchProblem(search, accounts.data, categories.data, 'save')
  const searchable = problem === null
  // How many match: the count the Transactions page asks for, with the same key. A file holds the oldest EXPORT_MAX_ROWS, so say so before the reader downloads, not only in the file.
  const { data: total, isError: countFailed } = useQuery({ ...transactionCountQuery(search), placeholderData: keepPreviousData, enabled: searchable })
  // While nothing is searched for, the previous search's count is kept as a placeholder, and is not this search's.
  const matching = searchable ? total : undefined
  const tooMany = matching !== undefined && matching > EXPORT_MAX_ROWS
  const describedBy = [matching !== undefined && 'filter-download-count', tooMany && 'filter-download-warning', 'filter-download-hint'].filter(Boolean).join(' ')

  return (
    <>
      <p id="filter-download-hint" className="mt-2 text-muted-foreground">
        Download CSV saves the Transactions that match the filters you last searched with, oldest first, to open in a spreadsheet. Once saved, a file is outside
        Fernledger's sign-in: see{' '}
        <a href="https://github.com/markc647/fernledger#what-it-cant-protect-against" className="underline underline-offset-4">
          what it can't protect against
        </a>
        .
      </p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <div role="status">
        {tooMany && (
          <p id="filter-download-warning" className="mt-2 font-medium">
            Only the oldest up to {EXPORT_MAX_ROWS.toLocaleString('en-NZ')} will be saved (fewer if Notes are long). Set From and To to one year at a time to save the
            rest.
          </p>
        )}
      </div>
      <TransactionFilters
        search={search}
        onSearch={onSearch}
        actions={({ unapplied }) => (
          <>
            {!unapplied && searchable ? (
              <a href={exportPath(search)} download className={buttonVariants({ variant: 'outline', size: 'touch' })} aria-describedby={describedBy}>
                Download CSV
              </a>
            ) : (
              <Button type="button" size="touch" variant="outline" disabled aria-describedby={describedBy}>
                Download CSV
              </Button>
            )}
            {/* Always in the page, so a screen reader announces the count when a search changes it. */}
            <span role="status">
              {matching !== undefined && (
                <span id="filter-download-count">
                  {matching.toLocaleString('en-NZ')} {matching === 1 ? 'Transaction matches' : 'Transactions match'}
                </span>
              )}
            </span>
          </>
        )}
      />
      {problem ? (
        <p role="alert" className="mt-4 font-medium">
          {problem}
        </p>
      ) : countFailed ? (
        <p role="alert" className="mt-4 font-medium">
          Fernledger couldn't count the Transactions that match. Reload the page to try again.
        </p>
      ) : null}
    </>
  )
}
