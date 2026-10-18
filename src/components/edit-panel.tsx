import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type Ref } from 'react'
import { FieldLabel } from '@/components/field-label'
import { NotATransfer, TreatAsTransferAgain } from '@/components/not-a-transfer'
import { RowPanel, type Drafts } from '@/components/row-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { HttpError, reasonOf } from '@/lib/me'
import { categoriesQuery } from '@/lib/queries'
import { countSentence, directionOf, savedRuleSentence, tooManyNote } from '@/lib/rule-from-transaction'
import { suggestRuleText } from '@/lib/rule-text'
import { ruleWhen } from '@/lib/rules'
import { NOT_TRANSFER_NOTE, notTransferSaved, transferEditHint, treatAsTransferAgainSaved, type TransferSource } from '@/lib/transfers'
import { useDebounced } from '@/lib/use-debounced'

/** What the panel needs to know about a Transaction: how to name it, its Override and Note now, and whether it is a Transfer. */
export type EditableTransaction = {
  id: number
  date: string
  description: string
  amountCents: number
  categoryId: number | null
  /** 'override' while the Category is the Admin's own choice. */
  categorySource: string | null
  /** Set while the Transaction is a Transfer, which an Override takes out of the Transfers. */
  transfer: TransferSource | null
  /** The Account of its matching Transaction, if it is paired, whether or not an Override or Not a Transfer means this one is no longer a Transfer. */
  transferAccountName: string | null
  /** What the Worker says the Admin can do about its Transfer: say Not a Transfer, or take it off if they have. */
  canMarkNotTransfer: boolean
  notTransfer: boolean
  note: string | null
}

/** The panel's `id`, which its Transaction's Edit button `aria-controls`. */
export const editPanelId = (id: number) => `transaction-${id}-panel`

/** The Rule fields of Create Rule while they are open: what the Rule looks for, and which way the money went ('' is either). */
export type RuleDraft = { text: string; direction: '' | 'in' | 'out' }

/** What has been typed into the panel and not saved: the Category chosen (null: No Override), the Note, and the Rule fields if Create Rule is open (null if not). */
export type EditDraft = { categoryId: number | null; note: string; rule: RuleDraft | null }

const textareaStyle =
  'block min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring'

/** How long the Admin stops typing before the count is asked for again: long enough that a few words typed at an ordinary speed are one request, since each one reads every Transaction. */
const COUNT_DELAY_MS = 700

type RuleCount = {
  /** The answer for the text and direction that were last asked about, or the one before while the next is on its way. */
  counts: { matches: number; uncategorised: number } | undefined
  failed: boolean
  /** An answer is on its way, or the Admin has typed since the one that is showing. */
  counting: boolean
  /** The answer on show is for what is in the boxes now (or could not be had): the Rule is not saved before the Admin has been told how many it matches. */
  ready: boolean
}

/**
 * The count of what the Rule's text matches, from the Rules' preview (POST /api/rules/preview, which reads every Transaction once: ADR 0004). It is asked for once the Admin has stopped typing for
 * COUNT_DELAY_MS (the first one at once: the box starts with a suggestion), and a request that is overtaken by the next is cancelled. An answer is kept while the fields are open, so a text that was
 * counted is not read again, and thrown away when they close (a Rule or an Override may have changed what it would say).
 */
function useRuleCount(rule: RuleDraft | null): RuleCount {
  const queryClient = useQueryClient()
  const open = rule !== null
  const text = rule?.text.trim() ?? ''
  const direction = rule?.direction ?? ''
  const askedText = useDebounced(text, COUNT_DELAY_MS, open)
  const askedDirection = useDebounced(direction, COUNT_DELAY_MS, open)
  useEffect(() => {
    if (!open) return
    return () => queryClient.removeQueries({ queryKey: ['rule-count'] })
  }, [open, queryClient])
  const count = useQuery({
    queryKey: ['rule-count', askedText, askedDirection],
    enabled: open && askedText !== '',
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // The previous answer stays while the next is asked for, so the line is not emptied and filled in again (which a screen reader would say twice).
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const res = await api.rules.preview.$post({ json: { textContains: askedText, direction: askedDirection === '' ? null : askedDirection, uncategorised: true } }, { init: { signal } })
      if (!res.ok) throw new HttpError(res.status)
      const { matches, uncategorised } = await res.json()
      return { matches, uncategorised: uncategorised ?? 0 }
    },
  })
  const current = text === askedText && direction === askedDirection
  return {
    counts: count.data,
    failed: count.isError,
    counting: text !== '' && (!current || count.isFetching),
    ready: text !== '' && current && !count.isFetching && !count.isPlaceholderData && (count.isSuccess || count.isError),
  }
}

/** The Rule fields of Create Rule, and the count of what the text matches. A screen reader is told the count politely, when it has changed, and not as each letter is typed: the line is only rewritten when an answer arrives. */
function CreateRuleFields({ rule, onChange, count, thisIsUncategorised, textRef }: { rule: RuleDraft; onChange: (rule: RuleDraft) => void; count: RuleCount; thisIsUncategorised: boolean; textRef: Ref<HTMLInputElement> }) {
  const typed = rule.text.trim() !== ''
  const note = count.counts ? tooManyNote(count.counts.uncategorised, thisIsUncategorised) : null

  return (
    // A group and not a section: the panel is already a region, and a second landmark inside it would be one more place for a screen reader's list to stop at.
    <div role="group" aria-labelledby="edit-rule-heading" className="space-y-4 rounded-xl border-2 p-4">
      <h3 id="edit-rule-heading" className="text-lg font-medium">
        Rule for Transactions like this one
      </h3>
      <p>Save Category and Rule adds the Rule last in the Rules, and gives the Category to the Uncategorised Transactions it matches.</p>
      <div>
        <FieldLabel
          htmlFor="edit-rule-text"
          label="Text contains"
          hintId="edit-rule-text-hint"
          hint="Looked for in the description and the bank's memo, ignoring capital letters A to Z. It starts as the words that name the shop, without the card number, date, receipt number and place. You can change it."
        />
        <Input id="edit-rule-text" ref={textRef} value={rule.text} maxLength={100} aria-describedby="edit-rule-text-hint" onChange={(event) => onChange({ ...rule, text: event.target.value })} />
      </div>
      <div>
        <label htmlFor="edit-rule-direction" className="block font-medium">
          Money in or out
        </label>
        <Select id="edit-rule-direction" value={rule.direction} onChange={(event) => onChange({ ...rule, direction: event.target.value as RuleDraft['direction'] })}>
          <option value="">Either</option>
          <option value="in">Money in only</option>
          <option value="out">Money out only</option>
        </Select>
      </div>
      <div>
        {/* Polite, and only rewritten when an answer arrives. "Counting…" is for the eye: a screen reader is told the result, not that it is on its way (and that it is busy). */}
        <div role="status" aria-live="polite" aria-atomic="true" aria-busy={count.counting}>
          {!typed ? (
            <p>Type what the Rule should look for to see how many Transactions match.</p>
          ) : count.failed ? (
            <p>Fernledger could not count how many match. You can still save the Rule.</p>
          ) : count.counts ? (
            <>
              <p className="font-medium">{countSentence(count.counts)}</p>
              {note && <p className="mt-1">{note}</p>}
            </>
          ) : null}
        </div>
        {count.counting && (
          <p aria-hidden className="text-muted-foreground">
            Counting…
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Sets a Transaction's Override and Note, in a panel (`RowPanel`) that sits under the Transaction's row in a list and under its Edit button on its details (`className`). Only what changed is sent, so only what changed is logged.
 * Create Rule opens the Rule fields below the Category and turns Save and Cancel into Save Category and Rule and Cancel Rule: the Category chosen is the Rule's, the text it looks for starts as the part of the
 * description that names the shop (`suggestRuleText`), and saving makes the Rule, gives its Category to the Uncategorised Transactions it matches and to this one (POST /api/rules/from-transaction), and says what it did.
 * For a Transfer it also offers Not a Transfer (and its undo), which is saved at once and not with the Save button; `onSaved` is then given what to say about it. The panel starts from `draft`, what was typed in it
 * before it was closed without being saved, and tells `onDraft` what it holds as that changes (null when it holds nothing unsaved), so that the page can keep it (`useDrafts`).
 */
export function EditPanel({
  row,
  className,
  drafts,
  onSaved,
  onCancel,
}: {
  row: EditableTransaction
  className?: string
  drafts?: Drafts<EditDraft>
  onSaved: (message?: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const { data: categories, isError } = useQuery(categoriesQuery)
  const startCategory = row.categorySource === 'override' ? row.categoryId : null
  const [draft] = useState(() => drafts?.get(row.id))
  const [categoryId, setCategoryId] = useState<number | null>(draft ? draft.categoryId : startCategory)
  const [note, setNote] = useState(draft ? draft.note : (row.note ?? ''))
  const [rule, setRule] = useState<RuleDraft | null>(draft ? draft.rule : null)
  const count = useRuleCount(rule)
  const param = { id: String(row.id) }
  const transferHint = transferEditHint(row)
  const noteChanged = note.trim() !== (row.note ?? '')
  const unsaved = categoryId !== startCategory || noteChanged || rule !== null
  useEffect(() => {
    drafts?.set(row.id, unsaved ? { categoryId, note, rule } : null)
  }, [categoryId, note, rule, unsaved, drafts, row.id])
  /** Saying Not a Transfer, or taking it off, saves at once and closes the panel, so what has been typed in it and not saved goes. */
  const unsavedWarning = unsaved ? "Changes in this panel that you haven't saved will be lost." : undefined

  // Create Rule and Cancel Rule each take away the button that was pressed, so focus goes to where the Admin goes next: the text the Rule looks for, or Create Rule again.
  const textBox = useRef<HTMLInputElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const focusNext = useRef<'text' | 'create' | null>(null)
  useEffect(() => {
    const target = focusNext.current === 'text' ? textBox.current : focusNext.current === 'create' ? createButton.current : null
    if (!target) return
    focusNext.current = null
    target.focus()
  })

  const save = useMutation({
    mutationFn: async () => {
      if (categoryId !== startCategory) {
        const res = await api.transactions[':id'].override.$put({ param, json: { categoryId } })
        if (!res.ok) throw new HttpError(res.status)
      }
      if (noteChanged) {
        const res = await api.transactions[':id'].note.$put({ param, json: { note } })
        if (!res.ok) throw new HttpError(res.status)
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      onSaved()
    },
  })

  const chosen = categories?.find((c) => c.id === categoryId)
  const ruleProblem = rule === null ? null : chosen === undefined ? 'Choose a Category above to save it with a Rule.' : rule.text.trim() === '' ? 'Type what the Rule should look for.' : null
  // The Note goes first, so that a Rule that is refused can be saved again without saving the Note twice (and the Rule is never made twice because of a Note that failed).
  const saveRule = useMutation({
    mutationFn: async (made: { rule: RuleDraft; categoryId: number }) => {
      if (noteChanged) {
        const res = await api.transactions[':id'].note.$put({ param, json: { note } })
        if (!res.ok) throw new HttpError(res.status)
      }
      const res = await api.rules['from-transaction'].$post({ json: { transactionId: row.id, textContains: made.rule.text.trim(), direction: made.rule.direction === '' ? null : made.rule.direction, categoryId: made.categoryId } })
      if (!res.ok) throw new HttpError(res.status, res.status === 409 ? await reasonOf(res) : undefined) // 409: 100 Rules already, or the Transaction changed under the Admin
      return res.json()
    },
    onSuccess: async (made, asked) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['transactions'] }), queryClient.invalidateQueries({ queryKey: ['rules'] }), queryClient.invalidateQueries({ queryKey: ['rerun'] })])
      const when = ruleWhen({ textContains: asked.rule.text.trim(), bankType: null, direction: asked.rule.direction === '' ? null : asked.rule.direction, minCents: null, maxCents: null })
      onSaved(savedRuleSentence(made, { when, categoryName: categories?.find((c) => c.id === asked.categoryId)?.name ?? 'chosen' }))
    },
  })
  const ruleFailure =
    saveRule.error instanceof HttpError
      ? saveRule.error.status === 409
        ? saveRule.error.reason === 'changed'
          ? 'This Transaction changed while you were saving. Try again.'
          : 'There are already 100 Rules. Remove one before adding another.'
        : saveRule.error.status === 404
          ? 'This Transaction is no longer there. Reload the page.'
          : 'The Rule could not be saved. Check the Category and the text, and try again.'
      : saveRule.isError
        ? 'The Rule could not be saved. Try again.'
        : ''

  const createRule = () => {
    focusNext.current = 'text'
    setRule({ text: suggestRuleText(row.description), direction: directionOf(row.amountCents) })
  }
  const cancelRule = () => {
    focusNext.current = 'create'
    saveRule.reset()
    setRule(null)
  }

  return (
    <RowPanel id={editPanelId(row.id)} title={`Edit Category and Note, ${row.description}, ${formatDate(row.date)}`} className={className}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (rule === null) save.mutate()
          else if (ruleProblem === null && count.ready && chosen) saveRule.mutate({ rule, categoryId: chosen.id })
        }}
      >
        <div>
          <label htmlFor="edit-category" className="block font-medium">
            Category
          </label>
          <Select
            id="edit-category"
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
            {rule === null
              ? "Choosing a Category sets an Override: it is this Transaction's Category, whatever else would apply."
              : "This is the Category the Rule gives to the Transactions that match it. It is this Transaction's Category too."}
            {transferHint && ` ${transferHint}`}
          </p>
          {isError && <p role="alert" className="mt-1 font-medium text-destructive">The Categories could not be loaded. Reload the page to try again.</p>}
        </div>
        {rule && <CreateRuleFields rule={rule} onChange={setRule} count={count} thisIsUncategorised={row.categoryId === null && row.transfer === null} textRef={textBox} />}
        <div>
          <label htmlFor="edit-note" className="block font-medium">
            Note
          </label>
          <textarea id="edit-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className={textareaStyle} />
          <p className="mt-1 text-muted-foreground">For example, "hearing aid — receipt in folder". Every Member can read it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Keyed, so each button is its own: pressing Create Rule or Cancel Rule takes it away, and focus is moved on purpose (above), not left to the one that React would have reused. */}
          {rule === null ? (
            <>
              <Button key="save" type="submit" size="touch" disabled={save.isPending || !categories}>
                Save
              </Button>
              {/* A Transfer is not spending, so it has no Category for a Rule to give: Not a Transfer, below, is what this panel offers it. */}
              {!row.transfer && (
                <Button key="create-rule" ref={createButton} type="button" size="touch" variant="outline" onClick={createRule}>
                  Create Rule
                </Button>
              )}
              <Button key="cancel" type="button" size="touch" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button key="save-rule" type="submit" size="touch" disabled={saveRule.isPending || !categories || ruleProblem !== null || !count.ready} aria-describedby={ruleProblem ? 'edit-rule-problem' : undefined}>
                Save Category and Rule
              </Button>
              <Button key="cancel-rule" type="button" size="touch" variant="outline" onClick={cancelRule}>
                Cancel Rule
              </Button>
            </>
          )}
        </div>
        {ruleProblem && (
          <p id="edit-rule-problem" className="text-muted-foreground">
            {ruleProblem}
          </p>
        )}
        {save.isError && <p role="alert" className="font-medium text-destructive">The changes could not be saved. Try again.</p>}
        {ruleFailure && <p role="alert" className="font-medium text-destructive">{ruleFailure}</p>}
      </form>
      {(row.canMarkNotTransfer || row.notTransfer) && (
        <div className="mt-4 border-t-2 pt-4">
          <h3 className="text-lg font-medium">Not a Transfer</h3>
          <p className="mt-1 text-muted-foreground">
            {row.notTransfer
              ? NOT_TRANSFER_NOTE
              : row.transferAccountName === null
                ? 'A Rule marks this as a Transfer. If that is wrong, choose Not a Transfer.'
                : 'Fernledger pairs a Transaction with one in another Account on the same date for the same amount. If that is wrong, choose Not a Transfer.'}
          </p>
          {row.notTransfer ? (
            <TreatAsTransferAgain id={row.id} warning={unsavedWarning} onDone={(paired) => onSaved(treatAsTransferAgainSaved(paired))} />
          ) : (
            <NotATransfer
              id={row.id}
              transfer={row}
              extra={unsavedWarning}
              onDone={() => onSaved(notTransferSaved())}
            />
          )}
        </div>
      )}
    </RowPanel>
  )
}
