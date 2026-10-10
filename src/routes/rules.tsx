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
import { announcement, estimateSentence, pausedSentence, progressSentence, restartNote, updatedSentence, waitBeforeAsking, type RerunJob } from '@/lib/rerun'
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

/** The latest time the Rules were applied to every Transaction (worker/rule-rerun.ts), running or finished; null if never. */
const rerunQuery = queryOptions({
  queryKey: ['rerun'],
  queryFn: async (): Promise<RerunJob | null> => {
    const res = await api.rules.rerun.$get()
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()).job
  },
  // The page itself keeps this up to date while a run is going; a refetch in the middle of that would only show an older step.
  staleTime: Infinity,
  refetchOnWindowFocus: false,
})

const INTRO =
  'A Rule is used for new Transactions as they are imported. The Transactions you already have change only when you choose Apply the Rules to all Transactions, below.'
/** Said after any change to the Rules, and before one while a run is going: that run starts again, so it uses the change. */
const THEN_APPLY = 'To use the change on the Transactions you already have, choose Apply the Rules to all Transactions, below.'
const RUN_GOING_BEFORE = 'A run is going. Saving starts it again from the first Transaction.'
const afterChange = (runGoing: boolean) => (runGoing ? 'The run that is going starts again from the first Transaction, so that it uses the change.' : THEN_APPLY)

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
  // While a run is going, a change to the Rules sends it back to the first Transaction, and the form and the confirmation say so.
  const { data: rerun } = useQuery(rerunQuery)
  const runGoing = rerun?.status === 'running'

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
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['rules'] }), queryClient.invalidateQueries({ queryKey: ['rerun'] })])
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
      message: `Moved Rule ${item.number} ${by < 0 ? 'up' : 'down'}. It is now Rule ${now} of ${items.length}. ${afterChange(runGoing)}`,
      focus: by < 0 ? [`rule-${item.rule.id}-up`, `rule-${item.rule.id}-down`] : [`rule-${item.rule.id}-down`, `rule-${item.rule.id}-up`],
    })
  }

  const columns: Column<Item>[] = [
    { key: 'order', header: 'Order', className: 'whitespace-nowrap', cell: (item) => item.number },
    { key: 'when', header: 'When', cell: (item) => sentence(ruleConditions(item.rule)) },
    { key: 'then', header: 'Then', cell: (item) => ruleResult(item.rule) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (item) =>
        removing === item.rule.id ? (
          <RemoveConfirm item={item} runGoing={runGoing} onDone={(message) => closed(message)} onCancel={() => closed('', `rule-${item.rule.id}-remove`)} />
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
      <p className="mt-2">{INTRO}</p>
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
          runGoing={runGoing}
          onDone={(message) => closed(message, editing.kind === 'edit' ? `rule-${editing.rule.id}-edit` : 'add-rule-button')}
          onCancel={() => closed('', editing.kind === 'edit' ? `rule-${editing.rule.id}-edit` : 'add-rule-button')}
        />
      )}
      {/* While a Rule is being changed (the form open, a removal being confirmed or a move going through) the run waits: what it did would be done again. */}
      <ApplyToHistory holding={editing !== null || removing !== null || move.isPending} />
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

/**
 * Applying the Rules to every Transaction on file. The Worker does it a chunk at a time, one chunk for each request (worker/rule-rerun.ts), so
 * this page asks for the next chunk for as long as a run is going and it is open, and shows how far it has got. A run is not lost when the page
 * is closed: it keeps its place and the Worker carries on by itself, slowly, and the page carries on again where it was when it is opened.
 * `holding` is true while the Admin is changing a Rule: the run waits, since a change sends it back to the start.
 * A run pauses itself when it has used its share of the free plan's day (the Worker says so in the job, `paused`), and the plan can
 * refuse a step outright (429) when the day's allowance is gone; either way the page asks again when the day changes, at 00:00 UTC.
 */
function ApplyToHistory({ holding }: { holding: boolean }) {
  const queryClient = useQueryClient()
  const { data: job, error } = useQuery(rerunQuery)
  // 'limit' is the free plan's allowance for the day being used up; the run keeps its place either way.
  const [problem, setProblem] = useState<'' | 'limit' | 'failed'>('')
  const [attempt, setAttempt] = useState(0)
  // Words are announced for a run the Admin is watching, not for the last finished run found when the page opens.
  const [watching, setWatching] = useState(false)
  const status = useRef<HTMLParagraphElement>(null)
  // How many times the page has asked whether the day has changed and been told to wait, since the run was last moving.
  const asked = useRef(0)

  const start = useMutation({
    mutationFn: async () => {
      const res = await api.rules.rerun.$post({ json: {} })
      if (res.status === 409) return null // one is already going (another page, or a second click): carry on with that one
      if (!res.ok) throw new HttpError(res.status)
      return (await res.json()).job
    },
    onSuccess: async (started) => {
      setProblem('')
      setWatching(true)
      if (started) queryClient.setQueryData(rerunQuery.queryKey, started)
      else await queryClient.invalidateQueries({ queryKey: rerunQuery.queryKey })
      // The button is off while it runs, so keyboard focus moves to the progress rather than being lost.
      status.current?.focus()
    },
  })

  const stop = useMutation({
    mutationFn: async () => {
      const res = await api.rules.rerun.stop.$post({ json: {} })
      if (res.status === 409) return null // it ended first
      if (!res.ok) throw new HttpError(res.status)
      return (await res.json()).job
    },
    onSuccess: async (stopped) => {
      if (stopped) queryClient.setQueryData(rerunQuery.queryKey, stopped)
      else await queryClient.invalidateQueries({ queryKey: rerunQuery.queryKey })
      status.current?.focus()
    },
  })

  const running = job?.status === 'running'
  const waitingForTheDay = running && (job?.paused === true || problem === 'limit')
  useEffect(() => {
    if (running) setWatching(true)
  }, [running])

  // The loop: one step at a time, never two at once, until the job is done, something goes wrong, or the page goes. It depends on whether a
  // run is going and not on how far it has got, so a step's answer does not restart it. It waits while a Rule is being changed, and while the
  // run is waiting for the day to change.
  const paused = job?.paused === true
  useEffect(() => {
    if (!running || paused || problem || holding) return
    let stopped = false
    ;(async () => {
      while (!stopped) {
        const res = await api.rules.rerun.step.$post({ json: {} })
        if (stopped) return
        if (!res.ok) return setProblem(res.status === 429 ? 'limit' : 'failed')
        const { job: next } = await res.json()
        if (stopped) return
        queryClient.setQueryData(rerunQuery.queryKey, next)
        if (!next?.paused) asked.current = 0
        if (next?.status !== 'running' || next.paused) {
          // Every Category shown in a list may have changed.
          await queryClient.invalidateQueries({ queryKey: ['transactions'] })
          return
        }
      }
    })().catch(() => {
      if (!stopped) setProblem('failed')
    })
    return () => {
      stopped = true
    }
  }, [running, paused, problem, holding, attempt, queryClient])

  // When the day changes (00:00 UTC) a run that was waiting for it is asked again. A page left open overnight carries it on. This device's
  // clock may be ahead of the Worker's, in which case the answer can still be to wait: the page then asks every few minutes (waitBeforeAsking),
  // and `attempt` is among the dependencies so that the timer is set again each time it has gone off.
  useEffect(() => {
    if (!waitingForTheDay) return
    const timer = setTimeout(() => {
      asked.current += 1
      setProblem('')
      setAttempt((n) => n + 1)
      void queryClient.invalidateQueries({ queryKey: rerunQuery.queryKey })
    }, waitBeforeAsking(new Date(), asked.current))
    return () => clearTimeout(timer)
  }, [waitingForTheDay, attempt, queryClient])

  const note = job ? restartNote(job) : null
  const estimate = job && !problem ? estimateSentence(job) : null
  return (
    <section aria-labelledby="rerun-heading" className="mt-6 max-w-xl rounded-xl border-2 p-4">
      <h2 id="rerun-heading" className="text-lg font-semibold">
        Apply the Rules to all Transactions
      </h2>
      <p className="mt-1">
        Fernledger goes through every Transaction you have, a few at a time, and gives each the Category of the first Rule that matches it. A Transaction that no Rule matches any more loses the
        Category a Rule gave it. A Category you set by hand (an Override) is never changed.
      </p>
      <p className="mt-1">Change the Rules first, then apply them once.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button id="rerun-button" className="max-w-full py-2 whitespace-normal" size="touch" disabled={running || start.isPending || job === undefined} onClick={() => start.mutate()}>
          Apply the Rules to all Transactions
        </Button>
        {running && (
          <Button size="touch" variant="outline" className="max-w-full py-2 whitespace-normal" disabled={stop.isPending} onClick={() => stop.mutate()}>
            Stop applying the Rules
          </Button>
        )}
      </div>
      {/* Always in the page, so a screen reader announces the words when they change. They change a few times in a run, not at every step. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-3 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {job && (watching || running) ? announcement(job) : ''}
      </p>
      {job && (
        <div className="mt-2">
          {running && <progress aria-labelledby="rerun-heading" className="block h-4 w-full accent-primary" value={job.percent} max={100} />}
          <p className="mt-1">{progressSentence(job)}</p>
          <p className="mt-1 text-muted-foreground">{updatedSentence(job)}</p>
          {note && <p className="mt-1">{note}</p>}
          {running && holding && <p className="mt-1">Waiting while you change a Rule.</p>}
          {estimate && !holding && <p className="mt-1">{estimate}</p>}
          {running && job.paused && <p className="mt-1">Paused: it has used the share of today's free database allowance that it keeps for itself. {pausedSentence()}</p>}
        </div>
      )}
      {problem === 'limit' && (
        <p role="alert" className="mt-2 font-medium text-destructive">
          Fernledger has used up the database allowance the free plan gives for today. It has kept its place. {pausedSentence()}
        </p>
      )}
      {problem === 'failed' && (
        <div role="alert" className="mt-2 space-y-2 font-medium text-destructive">
          <p>That did not work. Fernledger has kept its place, so you can try again.</p>
          <Button size="touch" variant="outline" onClick={() => { setProblem(''); setAttempt(attempt + 1) }}>
            Try again
          </Button>
        </div>
      )}
      {(error || start.isError || stop.isError) && (
        <p role="alert" className="mt-2 font-medium text-destructive">
          {error ? "Fernledger couldn't find out whether the Rules are being applied. Reload the page to try again." : stop.isError ? 'The run could not be stopped. Try again.' : 'The Rules could not be applied. Try again.'}
        </p>
      )}
    </section>
  )
}

function RemoveConfirm({ item, runGoing, onDone, onCancel }: { item: Item; runGoing: boolean; onDone: (message: string) => void; onCancel: () => void }) {
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
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['rules'] }), queryClient.invalidateQueries({ queryKey: ['rerun'] })])
      onDone(
        `Removed Rule ${item.number}. It is no longer used for new Transactions. ${
          runGoing ? 'The run that is going starts again from the first Transaction, so that it no longer uses the Rule.' : 'Transactions it already put in a Category keep that Category until you apply the Rules to all Transactions.'
        }`,
      )
    },
  })

  return (
    <div role="group" aria-label={`Remove Rule ${item.number}`} className="space-y-2 text-start">
      <p>Remove Rule {item.number}? It will no longer be used for new Transactions. Transactions it already put in a Category keep that Category until you apply the Rules to all Transactions.</p>
      {runGoing && <p className="font-medium">A run is going. Removing the Rule starts it again from the first Transaction.</p>}
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
function RuleForm({ rule, runGoing, onDone, onCancel }: { rule?: RuleView; runGoing: boolean; onDone: (message: string) => void; onCancel: () => void }) {
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
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['rules'] }), queryClient.invalidateQueries({ queryKey: ['rerun'] })])
      onDone(`${rule ? 'Saved the changes to the Rule.' : 'Added the Rule.'} It is used for new Transactions as they are imported. ${afterChange(runGoing)}`)
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
      {runGoing && <p className="mt-1 font-medium">{RUN_GOING_BEFORE}</p>}
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
              A Transaction this Rule marks is a Transfer even if no matching Transaction is found in another Account, so it is not counted as spending. The mark goes on new Transactions as they are imported, and on the ones you already have when you apply the Rules to all Transactions. If the banks date the two halves of a Transfer on different days, write a Rule that marks them as a Transfer.
            </p>
          )}
          {categoriesFailed && <p role="alert" className="mt-1 font-medium text-destructive">The Categories could not be loaded. Reload the page to try again.</p>}
          {rule?.categoryRemoved && <p className="mt-1 text-muted-foreground">This Rule's Category, {rule.categoryName}, was removed. Choose another to make the Rule work again.</p>}
        </div>

        <div>
          {/* The longest label here. A Button does not wrap by default; at 320px and text size A++ this one is wider than the form around it, so it may wrap. */}
          <Button type="button" size="touch" variant="outline" className="max-w-full py-1 whitespace-normal" disabled={check.isPending} onClick={onCheck}>
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
                <p className="mt-1">Saving the Rule won't change {shown.matches === 1 ? 'it' : 'them'}. {shown.matches === 1 ? 'It changes' : 'They change'} when you apply the Rules to all Transactions.</p>
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
