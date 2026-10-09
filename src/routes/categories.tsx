import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { HttpError, meQuery } from '@/lib/me'
import { categoriesQuery } from '@/lib/queries'

export const Route = createFileRoute('/categories')({
  component: Categories,
  staticData: { nav: { label: 'Categories', order: 40 } },
})

type Category = { id: number; name: string }
type Editing = { kind: 'rename' | 'remove'; id: number } | null

const NAME_TAKEN = 'A Category with that name already exists.'
const NAME_HINT = 'Names are 1 to 40 characters, and each Category needs a different one.'

/**
 * Folds case the way the Worker's unique index does (SQLite NOCASE, which covers A to Z only), so this check and the
 * server agree on which names clash: "Café" and "CAFÉ" are different names to both.
 */
const asciiFold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/** Why a save failed, in words for the reader. */
const whyNot = (error: unknown) =>
  error instanceof HttpError && error.status === 409 ? NAME_TAKEN : error instanceof HttpError && error.status === 400 ? NAME_HINT : 'That did not work. Try again.'

function Categories() {
  const { data: me } = useQuery(meQuery)
  const { data: categories, error } = useQuery(categoriesQuery)
  const [editing, setEditing] = useState<Editing>(null)
  const [notice, setNotice] = useState('')
  // Until `me` arrives nobody is the Admin: the controls fail closed. The API refuses a Member's write whatever the page shows.
  const isAdmin = me?.role === 'admin'

  // Back to the button that opened the form (or, if its row is gone, the message), so keyboard focus is never lost.
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
  const sameName = (name: string, exceptId?: number) => categories?.some((c) => c.id !== exceptId && asciiFold(c.name) === asciiFold(name.trim())) ?? false

  const columns: Column<Category>[] = [{ key: 'name', header: 'Category', cell: (c) => c.name }]
  if (isAdmin)
    columns.push({
      key: 'actions',
      header: 'Actions',
      cell: (c) =>
        editing?.id === c.id && editing.kind === 'rename' ? (
          <RenameForm category={c} taken={sameName} onDone={(message) => done(message, `rename-${c.id}-button`)} onCancel={() => done('', `rename-${c.id}-button`)} />
        ) : editing?.id === c.id && editing.kind === 'remove' ? (
          <RemoveConfirm category={c} onDone={(message) => done(message)} onCancel={() => done('', `remove-${c.id}-button`)} />
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button id={`rename-${c.id}-button`} size="touch" variant="outline" aria-label={`Rename ${c.name}`} onClick={() => { setNotice(''); setEditing({ kind: 'rename', id: c.id }) }}>
              Rename
            </Button>
            <Button id={`remove-${c.id}-button`} size="touch" variant="outline" aria-label={`Remove ${c.name}`} onClick={() => { setNotice(''); setEditing({ kind: 'remove', id: c.id }) }}>
              Remove
            </Button>
          </div>
        ),
    })

  return (
    <>
      <h1 className="text-2xl font-semibold">Categories</h1>
      <p className="mt-2">
        A Category groups Transactions by purpose. {isAdmin ? 'Add, rename or remove them to suit you.' : 'Only the Admin can change them.'}
      </p>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {notice}
      </p>
      {isAdmin && <AddForm taken={sameName} onAdded={(name) => setNotice(`Added ${name}.`)} />}
      <div className="mt-6">
        {error ? (
          <p role="alert">Fernledger couldn't load the Categories. Reload the page to try again.</p>
        ) : !categories ? (
          <p role="status">Loading…</p>
        ) : (
          <ResponsiveTable caption="Categories" columns={columns} rows={categories} getRowKey={(c) => c.id} emptyMessage="There are no Categories. Add one above." />
        )}
      </div>
    </>
  )
}

function AddForm({ taken, onAdded }: { taken: (name: string) => boolean; onAdded: (name: string) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  // The list is on the page, so a name already in use is caught here; the Worker checks too.
  const [clash, setClash] = useState(false)
  const add = useMutation({
    mutationFn: async () => {
      const res = await api.categories.$post({ json: { name } })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories'] })
      onAdded(name.trim())
      setName('')
    },
  })

  return (
    <form
      aria-label="Add a Category"
      className="mt-4 flex max-w-xl flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (taken(name)) return setClash(true)
        add.mutate()
      }}
    >
      <div className="min-w-0 grow basis-60">
        <label htmlFor="new-category" className="block font-medium">
          New Category
        </label>
        <Input id="new-category" value={name} maxLength={40} required aria-describedby="new-category-hint" onChange={(event) => { setName(event.target.value); setClash(false); add.reset() }} />
      </div>
      <Button type="submit" size="touch" disabled={add.isPending || !name.trim()}>
        Add Category
      </Button>
      <p id="new-category-hint" className="basis-full text-muted-foreground">
        For example, Care Fees. {NAME_HINT}
      </p>
      {(clash || add.isError) && <p role="alert" className="basis-full font-medium text-destructive">{clash ? NAME_TAKEN : whyNot(add.error)}</p>}
    </form>
  )
}

function RenameForm({ category, taken, onDone, onCancel }: { category: Category; taken: (name: string, exceptId?: number) => boolean; onDone: (message: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(category.name)
  const [clash, setClash] = useState(false)
  const rename = useMutation({
    mutationFn: async () => {
      const res = await api.categories[':id'].$patch({ param: { id: String(category.id) }, json: { name } })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      // The Transactions list shows Category names too.
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['categories'] }), queryClient.invalidateQueries({ queryKey: ['transactions'] })])
      onDone(`Renamed ${category.name} to ${name.trim()}.`)
    },
  })

  return (
    <form
      className="flex flex-wrap items-end justify-end gap-2 text-start"
      onSubmit={(event) => {
        event.preventDefault()
        if (taken(name, category.id)) return setClash(true)
        rename.mutate()
      }}
    >
      <div>
        <label htmlFor={`rename-${category.id}`} className="block font-medium">
          Category name
        </label>
        <Input id={`rename-${category.id}`} value={name} maxLength={40} required autoFocus onChange={(event) => { setName(event.target.value); setClash(false) }} />
      </div>
      <Button type="submit" size="touch" disabled={rename.isPending || !name.trim()}>
        Save name
      </Button>
      <Button type="button" size="touch" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      {(clash || rename.isError) && <p role="alert" className="basis-full font-medium text-destructive">{clash ? NAME_TAKEN : whyNot(rename.error)}</p>}
    </form>
  )
}

function RemoveConfirm({ category, onDone, onCancel }: { category: Category; onDone: (message: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  // Opens on the safe answer. Cancelling puts focus back on the Remove button (Categories' `done`), and a removal on the message.
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  const remove = useMutation({
    mutationFn: async () => {
      const res = await api.categories[':id'].$delete({ param: { id: String(category.id) }, json: {} })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
    onSuccess: async ({ overrides }) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['categories'] }), queryClient.invalidateQueries({ queryKey: ['transactions'] })])
      onDone(
        overrides === 0
          ? `Removed ${category.name}.`
          : `Removed ${category.name}. It was the Override on ${overrides} ${overrides === 1 ? 'Transaction' : 'Transactions'}. Each uses its Rule or Akahu category if it has one, and is Uncategorised if not.`,
      )
    },
  })

  return (
    <div role="group" aria-label={`Remove ${category.name}`} className="space-y-2 text-start">
      <p>Remove {category.name}? Transactions with it as their Override lose that Override and fall back to their Rule or Akahu category, or Uncategorised if neither applies.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="touch" aria-label={`Yes, remove ${category.name}`} disabled={remove.isPending} onClick={() => remove.mutate()}>
          Yes, remove
        </Button>
        <Button ref={keep} size="touch" variant="outline" onClick={onCancel}>
          Keep it
        </Button>
      </div>
      {remove.isError && <p role="alert" className="font-medium text-destructive">{whyNot(remove.error)}</p>}
    </div>
  )
}
