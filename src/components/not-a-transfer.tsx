import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { HttpError } from '@/lib/me'
import { notTransferQuestion, type TransferFields } from '@/lib/transfers'

/** What went wrong, in words: a 409 means the Transaction changed under the Admin (an Import moved its pairing on), so the page is out of date. */
const failure = (error: unknown) =>
  error instanceof HttpError && error.status === 409 ? 'This Transaction has changed. Reload the page and try again.' : 'The change could not be saved. Try again.'

/**
 * Not a Transfer, for the Admin: a pairing or a Rule made a Transfer of something that is not one. The button asks first, naming the matching
 * Transaction, because it changes two Transactions at once. Saying yes marks both, and `onDone` is called once it is saved. `extra` is added to
 * the question, for something the Admin should know first. Only the Admin is shown it, and the API refuses anyone else.
 */
export function NotATransfer({ id, transfer, extra, onDone }: { id: number; transfer: Pick<TransferFields, 'transferAccountName'>; extra?: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const questionId = useId()
  const [asking, setAsking] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const question = useRef<HTMLParagraphElement>(null)
  const returning = useRef(false)
  // Asking moves focus to the question, so it is read out; keeping the Transfer moves focus back to the button.
  useEffect(() => {
    if (asking) question.current?.focus()
    else if (returning.current) {
      returning.current = false
      button.current?.focus()
    }
  }, [asking])

  const mark = useMutation({
    mutationFn: async () => {
      const res = await api.transactions[':id']['not-transfer'].$post({ param: { id: String(id) }, json: {} })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      onDone()
    },
  })

  if (!asking)
    return (
      <Button ref={button} type="button" size="touch" variant="outline" className="mt-2" onClick={() => setAsking(true)}>
        Not a Transfer
      </Button>
    )

  return (
    <div role="group" aria-labelledby={questionId} className="mt-2 max-w-xl rounded-xl border-2 p-4">
      <p id={questionId} ref={question} tabIndex={-1} className="font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Mark as Not a Transfer?
      </p>
      <p className="mt-1">
        {notTransferQuestion(transfer)}
        {extra ? ` ${extra}` : ''}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="touch" disabled={mark.isPending} onClick={() => mark.mutate()}>
          Yes, mark Not a Transfer
        </Button>
        <Button
          type="button"
          size="touch"
          variant="outline"
          disabled={mark.isPending}
          onClick={() => {
            mark.reset()
            returning.current = true
            setAsking(false)
          }}
        >
          Keep as a Transfer
        </Button>
      </div>
      {mark.isError && <p role="alert" className="mt-2 font-medium text-destructive">{failure(mark.error)}</p>}
    </div>
  )
}

/**
 * "Undo: treat as a Transfer again", for the Admin, on a Transaction marked Not a Transfer. It takes the mark off both halves and pairs each with
 * what matches now, and `onDone` is told whether anything was paired. No question first: it is the undo.
 */
export function TreatAsTransferAgain({ id, onDone }: { id: number; onDone: (paired: boolean) => void }) {
  const queryClient = useQueryClient()
  const undo = useMutation({
    mutationFn: async () => {
      const res = await api.transactions[':id']['not-transfer'].$delete({ param: { id: String(id) }, json: {} })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
    onSuccess: async ({ paired }) => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      onDone(paired)
    },
  })

  return (
    <>
      <Button type="button" size="touch" variant="outline" className="mt-2" disabled={undo.isPending} onClick={() => undo.mutate()}>
        Undo: treat as a Transfer again
      </Button>
      {undo.isError && <span role="alert" className="mt-2 block font-medium text-destructive">{failure(undo.error)}</span>}
    </>
  )
}
