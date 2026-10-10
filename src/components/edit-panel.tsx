import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Amount } from '@/components/amount'
import { NotATransfer, TreatAsTransferAgain } from '@/components/not-a-transfer'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { HttpError } from '@/lib/me'
import { categoriesQuery } from '@/lib/queries'
import { notTransferSaved, transferEditHint, treatAsTransferAgainSaved, type TransferSource } from '@/lib/transfers'

/** What the panel needs to know about a Transaction: how to name it, and its Override and Note now. */
export type EditableTransaction = {
  id: number
  date: string
  description: string
  amountCents: number
  categoryId: number | null
  /** 'override' while the Category is the Admin's own choice. */
  categorySource: string | null
  /** Set while the Transaction is a Transfer, which an Override turns into spending. */
  transfer: TransferSource | null
  /** The Account of its matching Transaction, if it is paired, whether or not an Override makes this one spending. */
  transferAccountName: string | null
  /** What the Worker says the Admin can do about its Transfer: say Not a Transfer, or take it off if they have. */
  canMarkNotTransfer: boolean
  notTransfer: boolean
  note: string | null
}

const textareaStyle =
  'block min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring'

/**
 * Sets a Transaction's Override and Note. Only what changed is sent, so only what changed is logged. For a Transfer it also offers Not a Transfer
 * (and its undo), which is saved at once and not with the Save button; `onSaved` is then given what to say about it.
 */
export function EditPanel({ row, onSaved, onCancel }: { row: EditableTransaction; onSaved: (message?: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const { data: categories, isError } = useQuery(categoriesQuery)
  const startCategory = row.categorySource === 'override' ? row.categoryId : null
  const [categoryId, setCategoryId] = useState<number | null>(startCategory)
  const [note, setNote] = useState(row.note ?? '')
  const param = { id: String(row.id) }
  const transferHint = transferEditHint(row)
  const unsaved = categoryId !== startCategory || note.trim() !== (row.note ?? '')

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
          <Select
            id="edit-category"
            autoFocus
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
          </Select>
          <p id="edit-category-hint" className="mt-1 text-muted-foreground">
            Choosing a Category sets an Override: it is this Transaction's Category, whatever else would apply.
            {transferHint && ` ${transferHint}`}
          </p>
          {isError && <p role="alert" className="mt-1 font-medium text-destructive">The Categories could not be loaded. Reload the page to try again.</p>}
        </div>
        <div>
          <label htmlFor="edit-note" className="block font-medium">
            Note
          </label>
          <textarea id="edit-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className={textareaStyle} />
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
      {(row.canMarkNotTransfer || row.notTransfer) && (
        <div className="mt-4 border-t-2 pt-4">
          <h3 className="font-medium">Not a Transfer</h3>
          <p className="mt-1 text-muted-foreground">
            {row.notTransfer
              ? 'The Admin marked this Not a Transfer, so it counts as spending and is not paired with another Transaction.'
              : row.transferAccountName === null
                ? 'A Rule marks this as a Transfer. If that is wrong, choose Not a Transfer.'
                : 'Fernledger pairs a Transaction with one in another Account on the same date for the same amount. If that is wrong, choose Not a Transfer.'}
          </p>
          {row.notTransfer ? (
            <TreatAsTransferAgain id={row.id} onDone={(paired) => onSaved(treatAsTransferAgainSaved(paired))} />
          ) : (
            <NotATransfer
              id={row.id}
              transfer={row}
              extra={unsaved ? "Changes in this panel that you haven't saved will be lost." : undefined}
              onDone={() => onSaved(notTransferSaved())}
            />
          )}
        </div>
      )}
    </section>
  )
}
