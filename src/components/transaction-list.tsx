import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  createColumnHelper,
  FlexRender,
  functionalUpdate,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type Row as TableRow,
} from '@tanstack/react-table'
import type { InferResponseType } from 'hono/client'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { EditPanel } from '@/components/edit-panel'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { TransactionFilters } from '@/components/transaction-filters'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { meQuery } from '@/lib/me'
import { PAGE_SIZE, transactionsQuery } from '@/lib/queries'
import { SORT_KEYS, sortOf, tidy, type SortKey, type TransactionSearch } from '@/lib/transaction-search'

type Row = InferResponseType<typeof api.transactions.$get, 200>['transactions'][number]

// Sorting and paging happen on the server (the table only holds their state), so neither needs a client row model.
const features = tableFeatures({ rowSortingFeature, rowPaginationFeature })
const helper = createColumnHelper<typeof features, Row>()
const NO_ROWS: Row[] = []

/** How each sort reads in words, for the heading's menu on cards and for the line announcing the order. */
const SORT_WORDS: Record<SortKey, { ascending: string; descending: string }> = {
  date: { ascending: 'oldest first', descending: 'newest first' },
  account: { ascending: 'A to Z', descending: 'Z to A' },
  description: { ascending: 'A to Z', descending: 'Z to A' },
  category: { ascending: 'A to Z', descending: 'Z to A' },
  amount: { ascending: 'largest money out first', descending: 'largest money in first' },
}
const isSortKey = (id: string): id is SortKey => (SORT_KEYS as readonly string[]).includes(id)

/** The Category column: the effective Category, marked when the Admin set it by hand. */
function CategoryCell({ row }: { row: Row }) {
  if (row.categoryName === null) return <span className="text-muted-foreground">Uncategorised</span>
  return (
    <>
      {row.categoryName}
      {row.categorySource === 'override' && <span className="block text-muted-foreground">Override</span>}
    </>
  )
}

const hasFilter = (search: TransactionSearch) => search.account !== undefined || search.category !== undefined || !!search.from || !!search.to || !!search.q

/**
 * Transactions, a page at a time, with their Category and Note. `search` is what is asked for (filters, sort, page) and
 * `onSearch` changes it; the page keeps it in its address. The server does the searching, sorting and paging, and the table
 * (TanStack Table in manual mode) holds the sort and page. The Admin gets an Edit button on each row to set an Override
 * and a Note; a Member sees the same list read-only. With `showFilters` there is a search form above the list.
 */
export function TransactionList({
  search,
  onSearch,
  showFilters = false,
  emptyMessage,
  intro,
}: {
  search: TransactionSearch
  onSearch: (search: TransactionSearch, options?: { replace?: boolean }) => void
  showFilters?: boolean
  emptyMessage: ReactNode
  intro?: ReactNode
}) {
  const [editing, setEditing] = useState<Row | null>(null)
  const [saved, setSaved] = useState('')
  // A range that runs backwards can't match anything; the form explains it when typed, and a hand-edited address is explained here.
  const backwards = !!search.from && !!search.to && search.from > search.to
  const { data, error, isFetching } = useQuery({ ...transactionsQuery(search), placeholderData: keepPreviousData, enabled: !backwards })
  const { data: me } = useQuery(meQuery)
  // Until `me` arrives nobody is the Admin: the edit controls fail closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'
  const { sort, dir } = sortOf(search)
  const page = search.page ?? 1

  // After a save or cancel, focus goes back to the row's Edit button; if the row has left this list (it was categorised), to the status line.
  const status = useRef<HTMLParagraphElement>(null)
  const returnTo = useRef<number | null>(null)
  useEffect(() => {
    if (editing !== null || returnTo.current === null) return
    const button = document.getElementById(`edit-${returnTo.current}`)
    returnTo.current = null
    ;(button ?? status.current)?.focus()
  }, [editing, data])

  // After Previous or Next, the list starts again at its top. If the press left that button disabled (the first or last page)
  // focus would be lost, so it moves to the "Showing …" line, which also announces the new page.
  const results = useRef<HTMLDivElement>(null)
  const summary = useRef<HTMLParagraphElement>(null)
  const paged = useRef(false)
  const lastPage = data !== undefined && page * PAGE_SIZE >= data.total
  useEffect(() => {
    if (!paged.current || isFetching) return // wait for the new page, so what is announced and scrolled to is the new list
    paged.current = false
    results.current?.scrollIntoView({ block: 'start' })
    if (page === 1 || lastPage) summary.current?.focus({ preventScroll: true })
  }, [page, lastPage, isFetching])

  // A page past the end (the history shrank, or the address was edited) goes to the last one that has Transactions.
  const lastPageNumber = data && data.total > 0 ? Math.ceil(data.total / PAGE_SIZE) : undefined
  useEffect(() => {
    if (lastPageNumber !== undefined && !isFetching && page > lastPageNumber) onSearch(tidy({ ...search, page: lastPageNumber }), { replace: true })
  }, [lastPageNumber, isFetching, page, search, onSearch])

  const linkSearch = JSON.stringify(search)
  const columns = useMemo(() => {
    const here: TransactionSearch = JSON.parse(linkSearch)
    return helper.columns([
      helper.accessor('date', { header: 'Date', sortDescFirst: true, cell: (info) => <span className="whitespace-nowrap">{formatDate(info.getValue())}</span> }),
      helper.accessor('accountName', { id: 'account', header: 'Account' }),
      helper.accessor('description', {
        header: 'Description',
        cell: (info) => (
          <Link
            to="/transactions/$id"
            params={{ id: String(info.row.original.id) }}
            search={here}
            className="inline-flex min-h-11 max-w-full items-center text-start [overflow-wrap:anywhere] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      helper.accessor('categoryName', { id: 'category', header: 'Category', cell: (info) => <CategoryCell row={info.row.original} /> }),
      helper.accessor('note', {
        header: 'Note',
        enableSorting: false,
        cell: (info) =>
          info.getValue() ? (
            <span className="whitespace-pre-line">{info.getValue()}</span>
          ) : (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">No Note</span>
            </>
          ),
      }),
      helper.accessor('amountCents', { id: 'amount', header: 'Amount', cell: (info) => <Amount cents={info.getValue()} showLabel /> }),
      ...(isAdmin
        ? [
            helper.display({
              id: 'actions',
              header: 'Actions',
              enableSorting: false,
              cell: (info) => (
                <Button
                  id={`edit-${info.row.original.id}`}
                  size="touch"
                  variant="outline"
                  aria-label={`Edit Category and Note for ${info.row.original.description}, ${formatDate(info.row.original.date)}`}
                  onClick={() => {
                    setSaved('')
                    setEditing(info.row.original)
                  }}
                >
                  Edit
                </Button>
              ),
            }),
          ]
        : []),
    ])
  }, [isAdmin, linkSearch])

  const table = useTable({
    features,
    columns,
    data: data?.transactions ?? NO_ROWS,
    rowCount: data?.total,
    manualSorting: true,
    manualPagination: true,
    enableSortingRemoval: false,
    enableMultiSort: false,
    getRowId: (row) => String(row.id),
    state: { sorting: [{ id: sort, desc: dir === 'desc' }], pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE } },
    onSortingChange: (updater) => {
      const [next] = functionalUpdate(updater, [{ id: sort, desc: dir === 'desc' }])
      if (next && isSortKey(next.id)) onSearch(tidy({ ...search, sort: next.id, dir: next.desc ? 'desc' : 'asc', page: undefined }))
    },
    onPaginationChange: (updater) => {
      const next = functionalUpdate(updater, { pageIndex: page - 1, pageSize: PAGE_SIZE })
      paged.current = true
      onSearch(tidy({ ...search, page: next.pageIndex + 1 }))
    },
  })

  const tableColumns: Column<TableRow<typeof features, Row>>[] = table.getAllLeafColumns().map((column) => {
    const sorted = column.getIsSorted()
    return {
      key: column.id,
      header: String(column.columnDef.header),
      align: column.id === 'amount' ? 'end' : 'start',
      cell: (row) => <FlexRender cell={row.getAllCellsByColumnId()[column.id]!} />,
      sort:
        column.getCanSort() && isSortKey(column.id)
          ? {
              direction: sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : null,
              set: (direction) => column.toggleSorting(direction === 'descending'),
              first: column.columnDef.sortDescFirst ? 'descending' : 'ascending',
              labels: SORT_WORDS[column.id],
            }
          : undefined,
    }
  })

  const finish = (row: Row, message: string) => {
    returnTo.current = row.id
    setSaved(message)
    setEditing(null)
  }

  const filtered = showFilters && hasFilter(search)

  return (
    <>
      {intro}
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {saved}
      </p>
      {isAdmin && editing && <EditPanel key={editing.id} row={editing} onSaved={() => finish(editing, `Saved ${editing.description}.`)} onCancel={() => finish(editing, '')} />}
      {showFilters && <TransactionFilters search={search} onSearch={onSearch} />}
      {backwards ? (
        <p role="alert" className="mt-4 font-medium">
          The “To” date is before the “From” date. Change one of them to see Transactions.
        </p>
      ) : error ? (
        <p role="alert" className="mt-4">Fernledger couldn't load the Transactions. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status" className="mt-4">Loading…</p>
      ) : data.total === 0 ? (
        <p role="status" className="mt-4">{filtered ? 'No Transactions match these filters.' : emptyMessage}</p>
      ) : (
        <div ref={results} aria-busy={isFetching} className="mt-4 scroll-mt-4">
          <p ref={summary} role="status" tabIndex={-1} className="mb-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Showing {((page - 1) * PAGE_SIZE + 1).toLocaleString('en-NZ')} to {Math.min(page * PAGE_SIZE, data.total).toLocaleString('en-NZ')} of{' '}
            {data.total.toLocaleString('en-NZ')}
            {filtered ? ' matching' : ''}, sorted by {String(table.getColumn(sort)?.columnDef.header)}, {SORT_WORDS[sort][dir === 'asc' ? 'ascending' : 'descending']}.
          </p>
          <ResponsiveTable caption={filtered ? 'Transactions matching the search' : 'Transactions'} columns={tableColumns} rows={table.getRowModel().rows} getRowKey={(row) => row.id} />
          <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="touch" variant="outline" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              Previous
            </Button>
            <Button size="touch" variant="outline" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              Next
            </Button>
            <span>
              Page {page.toLocaleString('en-NZ')} of {table.getPageCount().toLocaleString('en-NZ')}
            </span>
          </nav>
        </div>
      )}
    </>
  )
}
