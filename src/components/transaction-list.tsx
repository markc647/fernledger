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
import { MessageSquareText } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { EditPanel } from '@/components/edit-panel'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { TransactionFilters } from '@/components/transaction-filters'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { KIND_NOTES } from '@/lib/category-kinds'
import { formatDate } from '@/lib/format'
import { meQuery } from '@/lib/me'
import { accountsQuery, categoriesQuery, PAGE_SIZE, transactionCountQuery, transactionsQuery } from '@/lib/queries'
import { noSuchOf, SORT_KEYS, sortOf, tidy, type DetailOrigin, type SortKey, type TransactionSearch } from '@/lib/transaction-search'
import { transferLabel } from '@/lib/transfers'

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

/**
 * The Category column: the effective Category, marked when the Admin set it by hand (Override) or a Rule gave it. A Transfer has
 * no Category to show, because it is not spending: it says where the money went or came from instead.
 */
function CategoryCell({ row }: { row: Row }) {
  const transfer = transferLabel(row)
  if (transfer !== null)
    return (
      <>
        {transfer}
        <span className="block text-muted-foreground">{row.transfer === 'rule' ? 'Marked by a Rule, not spending' : 'Not spending'}</span>
      </>
    )
  if (row.categoryName === null) return <span className="text-muted-foreground">Uncategorised</span>
  return (
    <>
      {row.categoryName}
      {row.categoryKind !== null && KIND_NOTES[row.categoryKind] !== null && <span className="block text-muted-foreground">{KIND_NOTES[row.categoryKind]}</span>}
      {row.categorySource === 'override' && <span className="block text-muted-foreground">Override</span>}
      {row.categorySource === 'rule' && <span className="block text-muted-foreground">Rule</span>}
    </>
  )
}

/**
 * The Note column: a Note is not written in the list (it can be long, and the list is for scanning), but is behind a button that opens it beside the row. A row without a Note shows nothing
 * (a screen reader is still told "No Note", in text only it reads). The button is 44px and named for its row, and the pop-up is the app's Popover as Radix leaves it: Escape and a press
 * outside close it, and Escape puts focus back on the button. Focus goes to the Note when it opens, so a Note too long for a short screen can be scrolled with the keyboard.
 */
function NoteCell({ row }: { row: Row }) {
  const noteId = useId()
  if (!row.note) return <span className="sr-only">No Note</span>
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="touch" className="px-0" aria-label={`Read the Note on ${row.description}, ${formatDate(row.date)}`}>
          <MessageSquareText className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        aria-label={`Note on ${row.description}`}
        aria-describedby={noteId}
        // As wide as a line of text reads well, never wider than the screen, and scrolling inside itself rather than running off a short one.
        className="max-h-(--radix-popover-content-available-height) w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain"
      >
        <p id={noteId} tabIndex={0} className="break-words whitespace-pre-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {row.note}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The Note column asks for the least room it can have, so a table gives it what its heading and the button need and no more. The plain table's heading wraps anywhere (`overflow-wrap` in
 * src/index.css), so `whitespace-nowrap` is what keeps "Note" whole when no row on the page has a button to hold the column open.
 */
const NOTE_COLUMN = 'w-px whitespace-nowrap'

const hasFilter = (search: TransactionSearch) => search.account !== undefined || search.category !== undefined || search.transfers !== undefined || !!search.from || !!search.to || !!search.q

/**
 * Transactions, a page at a time, with their Category and Note. `search` is what is asked for (filters, sort, page) and
 * `onSearch` changes it; the page keeps it in its address. The server does the searching, sorting and paging, and the table
 * (TanStack Table in manual mode) holds the sort and page. How many match is asked once per search, not per page (it reads
 * every Transaction the filters keep: ADR 0004). The Admin gets an Edit button on each row to set an Override and a Note; a
 * Member sees the same list read-only. With `showFilters` there is a search form above the list. A Transaction's details
 * come back to this list, or to the Uncategorised page when `origin` says that is where the reader started.
 */
export function TransactionList({
  search,
  onSearch,
  showFilters = false,
  origin,
  emptyMessage,
  intro,
}: {
  search: TransactionSearch
  onSearch: (search: TransactionSearch, options?: { replace?: boolean }) => void
  showFilters?: boolean
  origin?: DetailOrigin
  emptyMessage: ReactNode
  intro?: ReactNode
}) {
  const [editing, setEditing] = useState<Row | null>(null)
  const [saved, setSaved] = useState('')
  // A range that runs backwards can't match anything; the form explains it when typed, and a hand-edited address is explained here.
  const backwards = !!search.from && !!search.to && search.from > search.to
  // An Account or Category the address names that doesn't exist is explained by the page (noSuchOf), rather than shown as an error or an empty list.
  const accounts = useQuery({ ...accountsQuery, enabled: search.account !== undefined })
  const categories = useQuery({ ...categoriesQuery, enabled: typeof search.category === 'number' })
  const noSuch = noSuchOf(search, accounts.data, categories.data)
  const searchable = !backwards && !noSuch
  const { data, error, isFetching } = useQuery({ ...transactionsQuery(search), placeholderData: keepPreviousData, enabled: searchable })
  // The total is kept while a new search's is fetched, and a page or sort change doesn't ask again.
  const { data: total, error: countError } = useQuery({ ...transactionCountQuery(search), placeholderData: keepPreviousData, enabled: searchable })
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
  const lastPage = total !== undefined && page * PAGE_SIZE >= total
  useEffect(() => {
    if (!paged.current || isFetching) return // wait for the new page, so what is announced and scrolled to is the new list
    paged.current = false
    results.current?.scrollIntoView({ block: 'start' })
    if (page === 1 || lastPage) summary.current?.focus({ preventScroll: true })
  }, [page, lastPage, isFetching])

  // A page past the end (the history shrank, or the address was edited) goes to the last one that has Transactions.
  const lastPageNumber = total !== undefined && total > 0 ? Math.ceil(total / PAGE_SIZE) : undefined
  useEffect(() => {
    if (lastPageNumber !== undefined && !isFetching && page > lastPageNumber) onSearch(tidy({ ...search, page: lastPageNumber }), { replace: true })
  }, [lastPageNumber, isFetching, page, search, onSearch])

  const linkSearch = JSON.stringify(search)
  const columns = useMemo(() => {
    const here: TransactionSearch & { origin?: DetailOrigin } = { ...JSON.parse(linkSearch), origin }
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
        cell: (info) => <NoteCell row={info.row.original} />,
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
  }, [isAdmin, linkSearch, origin])

  const table = useTable({
    features,
    columns,
    data: data?.transactions ?? NO_ROWS,
    rowCount: total,
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
      className: column.id === 'note' ? NOTE_COLUMN : undefined,
      hideOnCard: column.id === 'note' ? (row) => !row.original.note : undefined,
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
      {isAdmin && editing && <EditPanel key={editing.id} row={editing} onSaved={(message) => finish(editing, message ?? `Saved ${editing.description}.`)} onCancel={() => finish(editing, '')} />}
      {showFilters && <TransactionFilters search={search} onSearch={onSearch} />}
      {backwards ? (
        <p role="alert" className="mt-4 font-medium">
          The “To” date is before the “From” date. Change one of them to see Transactions.
        </p>
      ) : noSuch ? (
        <p role="alert" className="mt-4 font-medium">
          There is no such {noSuch}. Choose one in the form above.
        </p>
      ) : error || countError ? (
        <p role="alert" className="mt-4">Fernledger couldn't load the Transactions. Reload the page to try again.</p>
      ) : !data || (data.transactions.length === 0 && total === undefined) ? (
        <p role="status" className="mt-4">Loading…</p>
      ) : total === 0 || (data.transactions.length === 0 && page === 1) ? (
        <p role="status" className="mt-4">{filtered ? 'No Transactions match these filters.' : emptyMessage}</p>
      ) : data.transactions.length === 0 ? (
        // A page past the end, until the effect above moves to the last one.
        <p role="status" className="mt-4">Loading…</p>
      ) : (
        <div ref={results} aria-busy={isFetching} className="mt-4 scroll-mt-4">
          <p ref={summary} role="status" tabIndex={-1} className="mb-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Showing {((page - 1) * PAGE_SIZE + 1).toLocaleString('en-NZ')} to{' '}
            {(total === undefined ? (page - 1) * PAGE_SIZE + data.transactions.length : Math.min(page * PAGE_SIZE, total)).toLocaleString('en-NZ')}
            {total === undefined ? '' : ` of ${total.toLocaleString('en-NZ')}`}
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
              Page {page.toLocaleString('en-NZ')}
              {total === undefined ? '' : ` of ${table.getPageCount().toLocaleString('en-NZ')}`}
            </span>
          </nav>
        </div>
      )}
    </>
  )
}
