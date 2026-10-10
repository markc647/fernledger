import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Amount } from '@/components/amount'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { categoriesQuery } from '@/lib/queries'
import { dollarsForInput, readDollars, ruleConditions, ruleResult, type RuleView } from '@/lib/rules'

export const Route = createFileRoute('/rules')({
  component: Rules,
  staticData: { nav: { label: 'Rules', adminOnly: true, order: 45 } },
})

/** The Rules in use, in the order they are checked. */
const rulesQuery = queryOptions({
  queryKey: ['rules'],
  queryFn: async (): Promise<RuleView[]> => {
    const res = await api.rules.$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

const NEW_ONLY =
  'A Rule is used for new Transactions as they are imported. It does not change the Transactions you already have; applying Rules to those will come in a later update.'

const count = new Intl.NumberFormat('en-NZ')

const sentence = (parts: string[]) => {
  const text = parts.join(' and ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

type Item = { rule: RuleView; number: number; first: boolean; last: boolean }
type Editing = { kind: 'add' } | { kind: 'edit'; rule: RuleView } | null

function Rules() {
  const { data: me } = useQuery(meQuery)
  // Until `me` arrives nobody is the Admin, so nothing is shown (fail closed). Hiding the navigation is a courtesy: the
  // API refuses a Member's write whatever this page shows.
  if (!me) return null
  return (
    <>
      <h1 className="text-2xl font-semibold">Rules</h1>
      {me.role === 'admin' ? <AdminRules /> : <p className="mt-2">Only the Admin can use this page.</p>}
    </>
  )
}

function AdminRules() {
  const queryClient = useQueryClient()
  const { data: rules, error } = useQuery(rulesQuery)
  const [editing, setEditing] = useState<Editing>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')

  // After a form or a confirmation closes, focus goes back to the button that opened it (or, if that is gone, to the message).
  const status = useRef<HTMLParagraphElement>(null)
  const focusAfter = useRef<{ id?: string } | null>(null)
  useEffect(() => {
    if (editing !== null || removing !== null || focusAfter.current === null) return
    const id = focusAfter.current.id
    focusAfter.current = null
    ;((id ? document.getElementById(id) : null) ?? status.current)?.focus()
  }, [editing, removing])
  const closed = (message: string, focusId?: string) => {
    focusAfter.current = { id: focusId }
    setNotice(message)
    setEditing(null)
    setRemoving(null)
  }

  // After a move the Rule is somewhere else in the list: keep keyboard focus on a button that still works for it.
  const moveFocus = useRef<string[] | null>(null)
  const move = useMutation({
    mutationFn: async (change: { ids: number[]; message: string; focus: string[] }) => {
      const res = await api.rules.order.$put({ json: { ids: change.ids } })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async (_data, change) => {
      moveFocus.current = change.focus
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      setNotice(change.message)
    },
    onError: (failure) =>
      setProblem(failure instanceof HttpError && failure.status === 400 ? 'The Rules have changed since this page loaded. Reload the page, then try again.' : 'That did not work. Try again.'),
  })

  // The buttons are disabled while a move is in flight, so this waits until it has finished and the new order is on the page.
  useEffect(() => {
    if (!moveFocus.current || move.isPending) return
    const target = moveFocus.current.map((id) => document.getElementById(id)).find((element) => element instanceof HTMLButtonElement && !element.disabled)
    moveFocus.current = null
    target?.focus()
  }, [rules, move.isPending])

  const items: Item[] = (rules ?? []).map((rule, i, all) => ({ rule, number: i + 1, first: i === 0, last: i === all.length - 1 }))
  const moveRule = (item: Item, by: -1 | 1) => {
    const ids = items.map((i) => i.rule.id)
    const at = item.number - 1
    ;[ids[at], ids[at + by]] = [ids[at + by]!, ids[at]!]
    const now = item.number + by
    setNotice('')
    setProblem('')
    move.mutate({
      ids,
      message: `Moved Rule ${item.number} ${by < 0 ? 'up' : 'down'}. It is now Rule ${now} of ${items.length}. A change in order is used for new Transactions only.`,
      focus: by < 0 ? [`rule-${item.rule.id}-up`, `rule-${item.rule.id}-down`] : [`rule-${item.rule.id}-down`, `rule-${item.rule.id}-up`],
    })
  }

  const columns: Column<Item>[] = [
    { key: 'order', header: 'Order', nowrap: true, cell: (item) => item.number },
    { key: 'when', header: 'When', cell: (item) => sentence(ruleConditions(item.rule)) },
    { key: 'then', header: 'Then', cell: (item) => ruleResult(item.rule) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (item) =>
        removing === item.rule.id ? (
          <RemoveConfirm item={item} onDone={(message) => closed(message)} onCancel={() => closed('', `rule-${item.rule.id}-remove`)} />
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button id={`rule-${item.rule.id}-up`} size="touch" variant="outline" aria-label={`Move up, Rule ${item.number}`} disabled={item.first || move.isPending} onClick={() => moveRule(item, -1)}>
              Move up
            </Button>
            <Button id={`rule-${item.rule.id}-down`} size="touch" variant="outline" aria-label={`Move down, Rule ${item.number}`} disabled={item.last || move.isPending} onClick={() => moveRule(item, 1)}>
              Move down
            </Button>
            <Button id={`rule-${item.rule.id}-edit`} size="touch" variant="outline" aria-label={`Edit Rule ${item.number}`} onClick={() => { setNotice(''); setProblem(''); setEditing({ kind: 'edit', rule: item.rule }) }}>
              Edit
            </Button>
            <Button id={`rule-${item.rule.id}-remove`} size="touch" variant="outline" aria-label={`Remove Rule ${item.number}`} onClick={() => { setNotice(''); setProblem(''); setRemoving(item.rule.id) }}>
              Remove
            </Button>
          </div>
        ),
    },
  ]

  return (
    <>
      <p className="mt-2">
        A Rule puts the Transactions that match it into a Category, or marks them as Transfers. Rules are checked from the top of the list, and the first one that matches is used. A Category you set by hand
        on a Transaction (an Override) always beats a Rule, and a Rule beats the category Akahu suggests, if you use Akahu Sync.
      </p>
      <p className="mt-2">{NEW_ONLY}</p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {notice}
      </p>
      {problem && <p role="alert" className="mt-2 font-medium text-destructive">{problem}</p>}
      {editing === null ? (
        <Button id="add-rule-button" className="mt-4" size="touch" onClick={() => { setNotice(''); setProblem(''); setRemoving(null); setEditing({ kind: 'add' }) }}>
          Add a Rule
        </Button>
      ) : (
        <RuleForm
          key={editing.kind === 'edit' ? editing.rule.id : 'add'}
          rule={editing.kind === 'edit' ? editing.rule : undefined}
          onDone={(message) => closed(message, editing.kind === 'edit' ? `rule-${editing.rule.id}-edit` : 'add-rule-button')}
          onCancel={() => closed('', editing.kind === 'edit' ? `rule-${editing.rule.id}-edit` : 'add-rule-button')}
        />
      )}
      <div className="mt-6">
        {error ? (
          <p role="alert">Fernledger couldn't load the Rules. Reload the page to try again.</p>
        ) : !rules ? (
          <p role="status">Loading…</p>
        ) : (
          <ResponsiveTable caption="Rules, in the order they are checked" columns={columns} rows={items} getRowKey={(item) => item.rule.id} emptyMessage="There are no Rules yet. Add one above." />
        )}
      </div>
    </>
  )
}

function RemoveConfirm({ item, onDone, onCancel }: { item: Item; onDone: (message: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  // Opens on the safe answer. Cancelling puts focus back on the Remove button, and a removal on the message.
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  const remove = useMutation({
    mutationFn: async () => {
      const res = await api.rules[':id'].$delete({ param: { id: String(item.rule.id) }, json: {} })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      onDone(`Removed Rule ${item.number}. It is no longer used for new Transactions; Transactions it already put in a Category keep that Category.`)
    },
  })

  return (
    <div role="group" aria-label={`Remove Rule ${item.number}`} className="space-y-2 text-start">
      <p>Remove Rule {item.number}? It will no longer be used for new Transactions. Transactions it already put in a Category keep that Category.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="touch" aria-label={`Yes, remove Rule ${item.number}`} disabled={remove.isPending} onClick={() => remove.mutate()}>
          Yes, remove
        </Button>
        <Button ref={keep} size="touch" variant="outline" onClick={onCancel}>
          Keep it
        </Button>
      </div>
      {remove.isError && <p role="alert" className="font-medium text-destructive">That did not work. Try again.</p>}
    </div>
  )
}

const selectStyle =
  'block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-2 aria-invalid:border-destructive'

type FormValues = { text: string; type: string; direction: '' | 'in' | 'out'; from: string; to: string; target: string }
type FieldId = 'criteria' | 'from' | 'to' | 'target'
/** Where focus goes for each kind of problem. */
const FIELD_ELEMENT: Record<FieldId, string> = { criteria: 'rule-text', from: 'rule-from', to: 'rule-to', target: 'rule-target' }

const initialValues = (rule?: RuleView): FormValues =>
  rule
    ? {
        text: rule.textContains ?? '',
        type: rule.bankType ?? '',
        direction: rule.direction ?? '',
        from: dollarsForInput(rule.minCents),
        to: dollarsForInput(rule.maxCents),
        // A Rule whose Category was removed starts with none chosen, so the Admin picks another.
        target: rule.transfer ? 'transfer' : rule.categoryId !== null && !rule.categoryRemoved ? String(rule.categoryId) : '',
      }
    : { text: '', type: '', direction: '', from: '', to: '', target: '' }

type Criteria = { textContains: string | null; bankType: string | null; direction: 'in' | 'out' | null; minCents: number | null; maxCents: number | null }

/** The criteria the form holds, or what is wrong with them. */
function readCriteria(values: FormValues): { criteria: Criteria; problems: Partial<Record<Exclude<FieldId, 'target'>, string>> } {
  const from = readDollars(values.from)
  const to = readDollars(values.to)
  const criteria: Criteria = {
    textContains: values.text.trim() || null,
    bankType: values.type.trim() || null,
    direction: values.direction || null,
    minCents: from.valid ? from.cents : null,
    maxCents: to.valid ? to.cents : null,
  }
  const problems: Partial<Record<Exclude<FieldId, 'target'>, string>> = {}
  if (!from.valid) problems.from = 'Enter an amount in dollars, such as 12.50.'
  if (!to.valid) problems.to = 'Enter an amount in dollars, such as 12.50.'
  if (criteria.minCents !== null && criteria.maxCents !== null && criteria.minCents > criteria.maxCents) problems.to = 'This must not be less than the amount it starts from.'
  if (Object.values(criteria).every((value) => value === null) && from.valid && to.valid) problems.criteria = 'Fill in at least one of the boxes above. A Rule with nothing to look for would match every Transaction.'
  return { criteria, problems }
}

type Sample = { id: number; date: string; description: string; bankType: string; amountCents: number }

/** Which criteria a result belongs to. Two sets of criteria are the same when they read the same. */
const criteriaKey = (criteria: Criteria) => JSON.stringify(criteria)

/** Adds a Rule, or changes `rule`. The Admin has to see how many Transactions the criteria match before saving them. */
function RuleForm({ rule, onDone, onCancel }: { rule?: RuleView; onDone: (message: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const { data: categories, isError: categoriesFailed } = useQuery(categoriesQuery)
  const [values, setValues] = useState(() => initialValues(rule))
  const [tried, setTried] = useState<'check' | 'save' | null>(null)
  const [checked, setChecked] = useState<{ key: string; matches: number; samples: Sample[] } | null>(null)

  const { criteria, problems } = readCriteria(values)
  const key = criteriaKey(criteria)
  // Saving a Rule as it is stored needs no check; any change to what it looks for does.
  const savedKey = rule ? criteriaKey(readCriteria(initialValues(rule)).criteria) : null
  const hasBeenChecked = Object.keys(problems).length === 0 && (checked?.key === key || key === savedKey)
  const shown = checked?.key === key ? checked : null

  const set = (change: Partial<FormValues>) => setValues({ ...values, ...change })
  const targetProblem = values.target === '' ? 'Choose a Category, or Mark as a Transfer.' : undefined
  // Problems show once the Admin has tried to check or save; the missing target only once they have tried to save.
  const error = (field: FieldId): string | undefined => (field === 'target' ? (tried === 'save' ? targetProblem : undefined) : tried ? problems[field] : undefined)
  // Takes the Admin to the first box with a problem.
  const focusFirst = (includeTarget: boolean) => {
    const first = problems.criteria ? 'criteria' : problems.from ? 'from' : problems.to ? 'to' : includeTarget && targetProblem ? 'target' : null
    if (first) document.getElementById(FIELD_ELEMENT[first])?.focus()
  }

  // The criteria asked about travel as the mutation's variables, and the result is filed under them. A callback that read
  // `key` instead would get the latest render's, since TanStack Query hands a pending mutation its newest options: boxes
  // edited while the check was out would then take the result for the old criteria as their own and enable Save.
  const check = useMutation({
    mutationFn: async (asked: Criteria) => {
      const res = await api.rules.preview.$post({ json: asked })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
    onSuccess: (data, asked) => setChecked({ key: criteriaKey(asked), matches: data.matches, samples: data.samples }),
  })

  const save = useMutation({
    mutationFn: async () => {
      const json = { ...criteria, categoryId: values.target === 'transfer' ? null : Number(values.target), transfer: values.target === 'transfer' }
      const res = rule ? await api.rules[':id'].$put({ param: { id: String(rule.id) }, json }) : await api.rules.$post({ json })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      onDone(`${rule ? 'Saved the changes to the Rule.' : 'Added the Rule.'} ${NEW_ONLY}`)
    },
  })

  const onCheck = () => {
    setTried('check')
    if (Object.keys(problems).length > 0) return focusFirst(false)
    check.mutate(criteria)
  }
  const onSave = () => {
    setTried('save')
    if (Object.keys(problems).length > 0 || targetProblem) return focusFirst(true)
    save.mutate()
  }

  const saveFailure =
    save.error instanceof HttpError && save.error.status === 409
      ? 'There are already 100 Rules. Remove one before adding another.'
      : save.isError
        ? 'The Rule could not be saved. Check the boxes above and try again.'
        : ''

  return (
    <section aria-labelledby="rule-form-heading" className="mt-4 max-w-xl rounded-xl border-2 p-4">
      <h2 id="rule-form-heading" className="text-lg font-semibold">
        {rule ? 'Change this Rule' : 'Add a Rule'}
      </h2>
      <p className="mt-1">A Transaction matches when it meets every box you fill in. Leave a box blank to ignore it.</p>
      <form
        noValidate
        className="mt-3 space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
      >
        <div>
          <label htmlFor="rule-text" className="block font-medium">
            Text contains
          </label>
          <Input
            id="rule-text"
            autoFocus
            value={values.text}
            maxLength={100}
            aria-invalid={error('criteria') ? true : undefined}
            aria-describedby={error('criteria') ? 'rule-text-hint rule-criteria-error' : 'rule-text-hint'}
            onChange={(event) => set({ text: event.target.value })}
          />
          <p id="rule-text-hint" className="mt-1 text-muted-foreground">
            Looked for in the description and the bank's memo, ignoring capital letters A to Z. A letter with an accent or macron, such as Ā, has to match as typed. For example, Woolworths.
          </p>
          {error('criteria') && <p id="rule-criteria-error" role="alert" className="mt-1 font-medium text-destructive">{error('criteria')}</p>}
        </div>
        <div>
          <label htmlFor="rule-type" className="block font-medium">
            Transaction type
          </label>
          <Input id="rule-type" value={values.type} maxLength={40} aria-describedby="rule-type-hint" onChange={(event) => set({ type: event.target.value })} />
          <p id="rule-type-hint" className="mt-1 text-muted-foreground">
            The bank's own type, as the bank's export shows it (Tran Type), such as EFTPOS. It has to match all of it, ignoring capital letters A to Z.
          </p>
        </div>
        <div>
          <label htmlFor="rule-direction" className="block font-medium">
            Money in or out
          </label>
          <select id="rule-direction" className={selectStyle} value={values.direction} onChange={(event) => set({ direction: event.target.value as FormValues['direction'] })}>
            <option value="">Either</option>
            <option value="in">Money in only</option>
            <option value="out">Money out only</option>
          </select>
        </div>
        <div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-0 grow basis-40">
              <label htmlFor="rule-from" className="block font-medium">
                Amount from ($)
              </label>
              <Input
                id="rule-from"
                inputMode="decimal"
                value={values.from}
                aria-invalid={error('from') ? true : undefined}
                aria-describedby={error('from') ? 'rule-amount-hint rule-from-error' : 'rule-amount-hint'}
                onChange={(event) => set({ from: event.target.value })}
              />
              {error('from') && <p id="rule-from-error" role="alert" className="mt-1 font-medium text-destructive">{error('from')}</p>}
            </div>
            <div className="min-w-0 grow basis-40">
              <label htmlFor="rule-to" className="block font-medium">
                Amount up to ($)
              </label>
              <Input
                id="rule-to"
                inputMode="decimal"
                value={values.to}
                aria-invalid={error('to') ? true : undefined}
                aria-describedby={error('to') ? 'rule-amount-hint rule-to-error' : 'rule-amount-hint'}
                onChange={(event) => set({ to: event.target.value })}
              />
              {error('to') && <p id="rule-to-error" role="alert" className="mt-1 font-medium text-destructive">{error('to')}</p>}
            </div>
          </div>
          <p id="rule-amount-hint" className="mt-1 text-muted-foreground">
            Both ends count. The amount is its size, whichever way the money went, so $50 covers $50 in and $50 out. Use Money in or out above to keep just one.
          </p>
        </div>
        <div>
          <label htmlFor="rule-target" className="block font-medium">
            What the Rule does
          </label>
          <select
            id="rule-target"
            className={selectStyle}
            value={values.target}
            aria-invalid={error('target') ? true : undefined}
            aria-describedby={error('target') ? 'rule-target-error' : values.target === 'transfer' ? 'rule-transfer-note' : undefined}
            onChange={(event) => set({ target: event.target.value })}
          >
            <option value="">Choose…</option>
            {categories?.map((category) => (
              <option key={category.id} value={category.id}>
                Put in the Category {category.name}
              </option>
            ))}
            <option value="transfer">Mark as a Transfer</option>
          </select>
          {error('target') && <p id="rule-target-error" role="alert" className="mt-1 font-medium text-destructive">{error('target')}</p>}
          {values.target === 'transfer' && (
            <p id="rule-transfer-note" className="mt-1 text-muted-foreground">
              The mark is stored on new Transactions now. It takes effect when Transfer pairing ships; until then they have no Category.
            </p>
          )}
          {categoriesFailed && <p role="alert" className="mt-1 font-medium text-destructive">The Categories could not be loaded. Reload the page to try again.</p>}
          {rule?.categoryRemoved && <p className="mt-1 text-muted-foreground">This Rule's Category, {rule.categoryName}, was removed. Choose another to make the Rule work again.</p>}
        </div>

        <div>
          <Button type="button" size="touch" variant="outline" disabled={check.isPending} onClick={onCheck}>
            Check how many match
          </Button>
          {/* Always in the page, so a screen reader announces the result when it appears. */}
          <div role="status" className="mt-2">
            {shown && (
              <>
                <p className="font-medium">
                  {shown.matches === 0
                    ? 'No Transactions you already have match.'
                    : `${count.format(shown.matches)} ${shown.matches === 1 ? 'Transaction' : 'Transactions'} you already have ${shown.matches === 1 ? 'matches' : 'match'}.`}
                </p>
                <p className="mt-1">Saving the Rule won't change {shown.matches === 1 ? 'it' : 'them'}. It is used for new Transactions as they are imported.</p>
                {shown.samples.length > 0 && (
                  <>
                    <p className="mt-2">The newest {shown.samples.length === 1 ? 'one' : shown.samples.length}:</p>
                    <ul className="mt-1 space-y-1">
                      {shown.samples.map((sample) => (
                        <li key={sample.id} className="flex flex-wrap items-start justify-between gap-x-4">
                          <span className="min-w-0 break-words">
                            {formatDate(sample.date)}, {sample.description}
                            {sample.bankType && <>, type {sample.bankType}</>}
                          </span>
                          <Amount cents={sample.amountCents} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {!shown && checked && Object.keys(problems).length === 0 && <p>You have changed what the Rule looks for. Check how many match again before you save.</p>}
          </div>
          {check.isError && <p role="alert" className="mt-2 font-medium text-destructive">Fernledger could not check how many match. Try again.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="touch" disabled={save.isPending || !categories || !hasBeenChecked}>
            Save Rule
          </Button>
          <Button type="button" size="touch" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {!hasBeenChecked && <p className="text-muted-foreground">Check how many Transactions match before you save.</p>}
        {saveFailure && <p role="alert" className="font-medium text-destructive">{saveFailure}</p>}
      </form>
    </section>
  )
}
