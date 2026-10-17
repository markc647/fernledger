import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { PageHeading } from '@/components/help-sheet'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { RowButton, useFocusBack } from '@/components/row-actions'
import { focusPanel, RowPanel, useDrafts, type Drafts } from '@/components/row-panel'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { capNotice, changeLine, laterChanges, monthChoices, savedMessage } from '@/lib/budgets'
import { formatBalance, formatMonth } from '@/lib/format'
import { HttpError, meQuery, reasonOf } from '@/lib/me'
import { budgetsQuery } from '@/lib/queries'
import { dollarsForInput, readDollars } from '@/lib/rules'

export const Route = createFileRoute('/budgets')({
  component: Budgets,
  staticData: { nav: { label: 'Budgets', group: 'setup', order: 46 } },
})

const AMOUNT_HINT = 'Enter an amount of more than $0 in dollars, such as 800 or 800.50.'
/** The amount hint, with how to have no Budget when there is one to end. */
const amountHint = (canEnd: boolean) => (canEnd ? `${AMOUNT_HINT} To have no Budget, use End Budget.` : AMOUNT_HINT)

/** A 400 from the Worker, with the field it named. */
class Refused extends HttpError {
  field: string
  constructor(field: string) {
    super(400)
    this.field = field
  }
}

/** What each field the Worker can refuse means to the Admin. A field the page did not expect means the page may be out of date. */
const REFUSED: Record<string, string> = {
  amountCents: AMOUNT_HINT,
  effectiveFrom: 'Choose a month from the list.',
  categoryId: 'This Category is no longer a Spending Category, so it cannot have a Budget. Reload the page to see the Categories as they are now.',
}

/** Why a save failed, in words for the reader. */
const whyNot = (error: unknown) =>
  error instanceof Refused
    ? (REFUSED[error.field] ?? 'Fernledger did not accept that. Reload the page, then try again.')
    : error instanceof HttpError && error.status === 409
      ? error.reason === 'changed'
        ? 'This Budget was changed just now. Try again.'
        : 'Fernledger keeps a limited number of Budget changes, and they cannot be removed, so there is no room to add another. Choose a month that already has a change, and replace it.'
      : 'That did not work. Try again.'

/** The id of a Category's Edit button, which focus goes back to when the panel it opened is closed. */
const editId = (categoryId: number) => `budget-${categoryId}-edit`
/** The id of its panel, which the button controls. */
const panelId = (categoryId: number) => `budget-${categoryId}-panel`

/** What has been typed into a Category's panel and not saved. */
type BudgetDraft = { amount: string; from: string }
/** What saving said, and of which Category: written under its row, and announced by the line at the top. */
type Notice = { message: string; categoryId: number }

function Budgets() {
  const { data: me } = useQuery(meQuery)
  const { data, error } = useQuery(budgetsQuery)
  const [editing, setEditing] = useState<number | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // What was typed in a panel and not saved stays until that Category's panel is saved or cancelled, whichever panel is open and whichever layout (table or cards) it is in.
  const drafts = useDrafts<BudgetDraft>()
  // Until `me` arrives nobody is the Admin: the controls fail closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'

  // Back to the button that opened the panel (or, if that is gone, the message).
  const status = useRef<HTMLParagraphElement>(null)
  const focusBack = useFocusBack(editing, status)
  const done = (categoryId: number, message: string) => {
    drafts.set(categoryId, null)
    focusBack(editId(categoryId))
    setNotice(message ? { message, categoryId } : null)
    setEditing(null)
  }

  type Row = NonNullable<typeof data>['budgets'][number]
  const thisMonth = data?.month
  const nearLimit = data ? capNotice(data.changeCount, data.changeLimit) : null
  const editingRow = data?.budgets.find((row) => row.categoryId === editing)
  // The panel is under its row; once it is closed, what saving said is, with the warning that the Budget changes are nearly used, which the Admin needs where they are working. Only one place has the warning.
  const warning = nearLimit ? <p className="font-medium">{nearLimit}</p> : null
  const noticeRow = notice && data?.budgets.some((row) => row.categoryId === notice.categoryId) ? notice : null
  const expanded =
    isAdmin && editingRow && thisMonth
      ? {
          after: editingRow.categoryId,
          content: (
            <div className="space-y-3">
              {warning}
              <BudgetPanel
                key={editingRow.categoryId}
                row={editingRow}
                thisMonth={thisMonth}
                drafts={drafts}
                onDone={(message) => done(editingRow.categoryId, message)}
                onCancel={() => done(editingRow.categoryId, '')}
              />
            </div>
          ),
        }
      : noticeRow
        ? {
            after: noticeRow.categoryId,
            content: (
              <div className="space-y-2">
                <p className="font-medium">{noticeRow.message}</p>
                {warning}
              </div>
            ),
          }
        : undefined
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
      header: 'Action',
      align: 'end',
      // One action, so a button named for it and not a menu; the panel it opens is under the row.
      cell: (row) => (
        <RowButton
          id={editId(row.categoryId)}
          label="Edit"
          name={`Edit Budget for ${row.categoryName}`}
          open={editing === row.categoryId}
          controls={panelId(row.categoryId)}
          onPress={() => {
            if (editing === row.categoryId) return focusPanel(panelId(row.categoryId))
            setNotice(null)
            setEditing(row.categoryId)
          }}
        />
      ),
    })

  return (
    <>
      <PageHeading
        help={
          <p>
            A Budget is the amount you plan to spend on a Category each month. A new Budget applies from the month you choose, and earlier months keep the Budget they had.
            Each month stands alone: what you don't spend isn't carried over. Only Spending Categories have a Budget. Transfers between your own Accounts, Pending Transactions and Loans aren't counted as spending, and money back, such as a refund, comes off what you spent.{' '}
            {isAdmin ? "Choose Edit on a Category's row to set or end its Budget." : 'Only the Admin can change them.'}
          </p>
        }
      >
        Budgets
      </PageHeading>
      {thisMonth && <p className="mt-2">This month is {formatMonth(thisMonth)}, in New Zealand time.</p>}
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className={cn('mt-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', noticeRow && 'sr-only')}>
        {notice?.message ?? ''}
      </p>
      {!expanded && warning && <div className="mt-2">{warning}</div>}
      <div className="mt-6">
        {error ? (
          <p role="alert">Fernledger couldn't load the Budgets. Reload the page to try again.</p>
        ) : !data ? (
          <p role="status">Loading…</p>
        ) : (
          <ResponsiveTable
            caption="Budgets"
            columns={columns}
            rows={data.budgets}
            getRowKey={(row) => row.categoryId}
            emptyMessage="There are no Categories. Add one on the Categories page."
            expanded={expanded}
          />
        )}
      </div>
    </>
  )
}

/** Sets or ends one Category's Budget from a month. A panel under the Category's row, not a form inside it, so it has the whole width of the table, and of a phone's screen. */
function BudgetPanel({
  row,
  thisMonth,
  drafts,
  onDone,
  onCancel,
}: {
  row: { categoryId: number; categoryName: string; amountCents: number | null; changes: { effectiveFrom: string; amountCents: number | null }[] }
  thisMonth: string
  drafts: Drafts<BudgetDraft>
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const startAmount = row.amountCents === null ? '' : dollarsForInput(row.amountCents)
  const [draft] = useState(() => drafts.get(row.categoryId))
  const [amount, setAmount] = useState(draft ? draft.amount : startAmount)
  const [from, setFrom] = useState(draft ? draft.from : thisMonth)
  useEffect(() => {
    drafts.set(row.categoryId, amount === startAmount && from === thisMonth ? null : { amount, from })
  }, [amount, from, startAmount, thisMonth, drafts, row.categoryId])
  const [invalid, setInvalid] = useState(false)
  const save = useMutation({
    mutationFn: async (amountCents: number | null) => {
      const res = await api.budgets[':categoryId'].$put({ param: { categoryId: String(row.categoryId) }, json: { effectiveFrom: from, amountCents } })
      if (res.status === 400) throw new Refused(((await res.json().catch(() => ({}))) as { field?: string }).field ?? '')
      if (!res.ok) throw new HttpError(res.status, res.status === 409 ? await reasonOf(res) : undefined) // 409: no room, or the Budget changed under the Admin
      return res.json()
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      onDone(savedMessage(row.categoryName, result))
    },
  })
  // Ending is offered only while the Category has a Budget now; the Worker also says so if there is nothing to end in the month chosen.
  const canEnd = row.amountCents !== null
  const later = laterChanges(row.changes, from)

  return (
    <RowPanel id={panelId(row.categoryId)} title={`Budget for ${row.categoryName}`}>
      <form
        className="space-y-4"
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
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setAmount(event.target.value)
              setInvalid(false)
              save.reset()
            }}
          />
          <p id={`${id}-hint`} className="mt-1 text-muted-foreground">
            {amountHint(canEnd)}
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
            Months before the one you choose keep the Budget they had.{canEnd && ' End Budget leaves the month you choose with no Budget until its next change.'}
          </p>
          {later.length > 0 && (
            <div className="mt-1">
              <p className="text-muted-foreground">This Category already has later changes. They stay as they are, so what you set applies only until the first of them:</p>
              <ul className="list-disc ps-6">
                {later.map((change) => (
                  <li key={change.effectiveFrom}>{changeLine(change)}</li>
                ))}
              </ul>
            </div>
          )}
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
            {invalid ? amountHint(canEnd) : whyNot(save.error)}
          </p>
        )}
      </form>
    </RowPanel>
  )
}
