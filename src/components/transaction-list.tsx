import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Amount } from '@/components/amount'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { categoriesQuery, PAGE_SIZE, transactionsQuery } from '@/lib/queries'

type Row = InferResponseType<typeof api.transactions.$get, 200>['transactions'][number]

const selectStyle =
  'block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring'

/** The Category column: the effective Category, marked when the Admin set it by hand (Override) or a Rule gave it. */
function CategoryCell({ row }: { row: Row }) {
  if (row.categoryName === null) return <span className="text-muted-foreground">Uncategorised</span>
  return (
    <>
      {row.categoryName}
      {row.categorySource === 'override' && <span className="block text-muted-foreground">Override</span>}
      {row.categorySource === 'rule' && <span className="block text-muted-foreground">Rule</span>}
    </>
  )
}

/**
 * Transactions, a page at a time, with their Category and Note. The Admin gets an Edit button on each row to set
 * an Override and a Note; a Member sees the same list read-only. `uncategorised` keeps only those with no Category.
 */
export function TransactionList({ uncategorised = false, emptyMessage, intro }: { uncategorised?: boolean; emptyMessage: ReactNode; intro?: ReactNode }) {
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Row | null>(null)
  const [saved, setSaved] = useState('')
  const { data, error } = useQuery({ ...transactionsQuery(page, uncategorised), placeholderData: keepPreviousData })
  const { data: me } = useQuery(meQuery)
  // Until `me` arrives nobody is the Admin: the edit controls fail closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'

  // After a save or cancel, focus goes back to the row's Edit button; if the row has left this list (it was categorised), to the status line.
  const status = useRef<HTMLParagraphElement>(null)
  const returnTo = useRef<number | null>(null)
  useEffect(() => {
    if (editing !== null || returnTo.current === null) return
    const button = document.getElementById(`edit-${returnTo.current}`)
    returnTo.current = null
    ;(button ?? status.current)?.focus()
  }, [editing, data])

  const columns: Column<Row>[] = [
    { key: 'date', header: 'Date', cell: (t) => <span className="whitespace-nowrap">{formatDate(t.date)}</span> },
    { key: 'account', header: 'Account', cell: (t) => t.accountName },
    { key: 'description', header: 'Description', cell: (t) => t.description },
    { key: 'category', header: 'Category', cell: (t) => <CategoryCell row={t} /> },
    {
      key: 'note',
      header: 'Note',
      cell: (t) =>
        t.note ? (
          <span className="whitespace-pre-line">{t.note}</span>
        ) : (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">No Note</span>
          </>
        ),
    },
    { key: 'amount', header: 'Amount', align: 'end', cell: (t) => <Amount cents={t.amountCents} showLabel /> },
  ]
  if (isAdmin)
    columns.push({
      key: 'actions',
      header: 'Actions',
      cell: (t) => (
        <Button id={`edit-${t.id}`} size="touch" variant="outline" aria-label={`Edit Category and Note for ${t.description}, ${formatDate(t.date)}`} onClick={() => { setSaved(''); setEditing(t) }}>
          Edit
        </Button>
      ),
    })

  const finish = (row: Row, message: string) => {
    returnTo.current = row.id
    setSaved(message)
    setEditing(null)
  }

  return (
    <>
      {intro}
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {saved}
      </p>
      {isAdmin && editing && <EditPanel key={editing.id} row={editing} onSaved={() => finish(editing, `Saved ${editing.description}.`)} onCancel={() => finish(editing, '')} />}
      {error ? (
        <p role="alert" className="mt-2">Fernledger couldn't load the Transactions. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status" className="mt-2">Loading…</p>
      ) : data.total === 0 ? (
        <p className="mt-2">{emptyMessage}</p>
      ) : (
        <>
          <div className="mt-4">
            <ResponsiveTable caption={uncategorised ? 'Uncategorised Transactions, newest first' : 'Transactions, newest first'} columns={columns} rows={data.transactions} getRowKey={(t) => t.id} />
          </div>
          <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="touch" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Newer
            </Button>
            <Button size="touch" variant="outline" disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>
              Older
            </Button>
            <span aria-live="polite">
              Showing {page * PAGE_SIZE + 1} to {Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
            </span>
          </nav>
        </>
      )}
    </>
  )
}

/** Sets a Transaction's Override and Note. Only what changed is sent, so only what changed is logged. */
function EditPanel({ row, onSaved, onCancel }: { row: Row; onSaved: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const { data: categories, isError } = useQuery(categoriesQuery)
  const startCategory = row.categorySource === 'override' ? row.categoryId : null
  const [categoryId, setCategoryId] = useState<number | null>(startCategory)
  const [note, setNote] = useState(row.note ?? '')
  const param = { id: String(row.id) }

  const save = useMutation({
    mutationFn: async () => {
      if (categoryId !== startCategory) {
        const res = await api.transactions[':id'].override.$put({ param, json: { categoryId } })
        if (!res.ok) throw new HttpError(res.status)
      }
      if (note.trim() !== (row.note ?? '')) {
        const res = await api.transactions[':id'].note.$put({ param, json: { note } })
        if (!res.ok) throw new HttpError(res.status)
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      onSaved()
    },
  })

  return (
    <section aria-labelledby="edit-heading" className="mt-4 max-w-xl rounded-xl border-2 p-4">
      <h2 id="edit-heading" className="text-lg font-semibold">
        Edit Category and Note
      </h2>
      <p className="mt-1">
        {formatDate(row.date)}, {row.description}, <Amount cents={row.amountCents} />
      </p>
      <form
        className="mt-3 space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div>
          <label htmlFor="edit-category" className="block font-medium">
            Category
          </label>
          <select
            id="edit-category"
            autoFocus
            className={selectStyle}
            value={categoryId ?? ''}
            aria-describedby="edit-category-hint"
            onChange={(event) => setCategoryId(event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">No Override</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p id="edit-category-hint" className="mt-1 text-muted-foreground">
            Choosing a Category sets an Override: it is this Transaction's Category, whatever else would apply.
          </p>
          {isError && <p role="alert" className="mt-1 font-medium text-destructive">The Categories could not be loaded. Reload the page to try again.</p>}
        </div>
        <div>
          <label htmlFor="edit-note" className="block font-medium">
            Note
          </label>
          <textarea
            id="edit-note"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={`${selectStyle} min-h-20`}
          />
          <p className="mt-1 text-muted-foreground">For example, "hearing aid — receipt in folder". Every Member can read it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="touch" disabled={save.isPending || !categories}>
            Save
          </Button>
          <Button type="button" size="touch" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {save.isError && <p role="alert" className="font-medium text-destructive">The changes could not be saved. Try again.</p>}
      </form>
    </section>
  )
}
