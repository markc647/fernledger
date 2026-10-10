import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { changeLine, monthChoices, savedMessage } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { budgetsQuery } from '@/lib/queries'
import { dollarsForInput, readDollars } from '@/lib/rules'

export const Route = createFileRoute('/budgets')({
  component: Budgets,
  staticData: { nav: { label: 'Budgets', order: 46 } },
})

const AMOUNT_HINT = 'Enter an amount of more than $0 in dollars, such as 800 or 800.50.'

/** Why a save failed, in words for the reader. */
const whyNot = (error: unknown) =>
  error instanceof HttpError && error.status === 400
    ? AMOUNT_HINT
    : error instanceof HttpError && error.status === 409
      ? 'There are too many Budget changes to add another. Choose a month that already has a change, and replace it.'
      : 'That did not work. Try again.'

function Budgets() {
  const { data: me } = useQuery(meQuery)
  const { data, error } = useQuery(budgetsQuery)
  const [editing, setEditing] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  // Until `me` arrives nobody is the Admin: the controls fail closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'

  // Back to the button that opened the panel (or, if that is gone, the message), so keyboard focus is never lost.
  const status = useRef<HTMLParagraphElement>(null)
  const focusAfter = useRef<{ id?: string } | null>(null)
  useEffect(() => {
    if (editing !== null || focusAfter.current === null) return
    const id = focusAfter.current.id
    focusAfter.current = null
    ;((id ? document.getElementById(id) : null) ?? status.current)?.focus()
  }, [editing])
  const done = (message: string, focusId?: string) => {
    focusAfter.current = { id: focusId }
    setNotice(message)
    setEditing(null)
  }

  type Row = NonNullable<typeof data>['budgets'][number]
  const thisMonth = data?.month
  const editingRow = data?.budgets.find((row) => row.categoryId === editing)
  const columns: Column<Row>[] = [
    { key: 'category', header: 'Category', cell: (row) => row.categoryName },
    {
      key: 'budget',
      header: 'This month',
      cell: (row) =>
        row.amountCents === null ? (
          <>
            <span>No Budget</span>
            {row.effectiveFrom !== null && <span className="block text-muted-foreground">since {formatMonth(row.effectiveFrom)}</span>}
          </>
        ) : (
          <>
            <span className="font-medium tabular-nums">{formatBalance(row.amountCents)} a month</span>
            <span className="block text-muted-foreground">from {formatMonth(row.effectiveFrom!)}</span>
          </>
        ),
    },
    {
      key: 'changes',
      header: 'Changes',
      cell: (row) =>
        row.changes.length === 0 ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          <ul className="space-y-1">
            {row.changes.map((change) => (
              <li key={change.effectiveFrom}>{changeLine(change)}</li>
            ))}
          </ul>
        ),
    },
  ]
  if (isAdmin)
    columns.push({
      key: 'actions',
      header: 'Actions',
      cell: (row) => (
        <Button
          id={`budget-${row.categoryId}-button`}
          size="touch"
          variant="outline"
          aria-label={`Edit Budget for ${row.categoryName}`}
          aria-expanded={editing === row.categoryId}
          onClick={() => {
            setNotice('')
            setEditing(row.categoryId)
          }}
        >
          Edit
        </Button>
      ),
    })

  return (
    <>
      <h1 className="text-2xl font-semibold">Budgets</h1>
      <p className="mt-2">
        A Budget is the amount you plan to spend on a Category each month. A new Budget applies from the month you choose, and earlier months keep the Budget they had.
        Each month stands alone: what you don't spend isn't carried over. Transfers between your own Accounts and Pending Transactions aren't counted as spending.{' '}
        {isAdmin ? 'Choose Edit on a Category to set or end its Budget.' : 'Only the Admin can change them.'}
      </p>
      {thisMonth && <p className="mt-2">This month is {formatMonth(thisMonth)}, in New Zealand time.</p>}
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {notice}
      </p>
      {isAdmin && editingRow && thisMonth && (
        <BudgetPanel
          key={editingRow.categoryId}
          row={editingRow}
          thisMonth={thisMonth}
          onDone={(message) => done(message, `budget-${editingRow.categoryId}-button`)}
          onCancel={() => done('', `budget-${editingRow.categoryId}-button`)}
        />
      )}
      <div className="mt-6">
        {error ? (
          <p role="alert">Fernledger couldn't load the Budgets. Reload the page to try again.</p>
        ) : !data ? (
          <p role="status">Loading…</p>
        ) : (
          <ResponsiveTable caption="Budgets" columns={columns} rows={data.budgets} getRowKey={(row) => row.categoryId} emptyMessage="There are no Categories. Add one on the Categories page." />
        )}
      </div>
    </>
  )
}

/** Sets or ends one Category's Budget from a month. A panel of its own above the list, not a form inside a row, so it has the whole width on a phone. */
function BudgetPanel({
  row,
  thisMonth,
  onDone,
  onCancel,
}: {
  row: { categoryId: number; categoryName: string; amountCents: number | null; changes: { amountCents: number | null }[] }
  thisMonth: string
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const [amount, setAmount] = useState(row.amountCents === null ? '' : dollarsForInput(row.amountCents))
  const [from, setFrom] = useState(thisMonth)
  const [invalid, setInvalid] = useState(false)
  const save = useMutation({
    mutationFn: async (amountCents: number | null) => {
      const res = await api.budgets[':categoryId'].$put({ param: { categoryId: String(row.categoryId) }, json: { effectiveFrom: from, amountCents } })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      onDone(savedMessage(row.categoryName, result))
    },
  })
  // Ending is offered only where there is something to end; the Worker also says so if there is nothing in the month chosen.
  const canEnd = row.changes.some((change) => change.amountCents !== null)

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-4 max-w-xl rounded-xl border-2 p-4">
      <h2 id={`${id}-heading`} className="text-lg font-semibold break-words">
        Budget for {row.categoryName}
      </h2>
      <form
        className="mt-3 space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          const typed = readDollars(amount)
          if (!typed.valid || typed.cents === null || typed.cents <= 0) return setInvalid(true)
          save.mutate(typed.cents)
        }}
      >
        <div>
          <label htmlFor={`${id}-amount`} className="block font-medium">
            Monthly Budget in dollars
          </label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            required
            autoFocus
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setAmount(event.target.value)
              setInvalid(false)
              save.reset()
            }}
          />
          <p id={`${id}-hint`} className="mt-1 text-muted-foreground">
            {AMOUNT_HINT}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-month`} className="block font-medium">
            Applies from
          </label>
          <Select
            id={`${id}-month`}
            value={from}
            aria-describedby={`${id}-month-hint`}
            onChange={(event) => {
              setFrom(event.target.value)
              save.reset()
            }}
          >
            {monthChoices(thisMonth).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
          <p id={`${id}-month-hint`} className="mt-1 text-muted-foreground">
            Months before the one you choose keep the Budget they had.{canEnd && ' End Budget leaves the month you choose, and the months after it, with no Budget.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="touch" disabled={save.isPending || !amount.trim()}>
            Save Budget
          </Button>
          {canEnd && (
            <Button type="button" size="touch" variant="outline" disabled={save.isPending} aria-describedby={`${id}-month-hint`} onClick={() => save.mutate(null)}>
              End Budget
            </Button>
          )}
          <Button type="button" size="touch" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {(invalid || save.isError) && (
          <p role="alert" className="font-medium text-destructive">
            {invalid ? AMOUNT_HINT : whyNot(save.error)}
          </p>
        )}
      </form>
    </section>
  )
}
