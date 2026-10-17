import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { RowButton, useFocusBack } from '@/components/row-actions'
import { focusPanel, RowPanel, useDrafts, type Drafts } from '@/components/row-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HttpError, meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { api } from '@/lib/api'

export const Route = createFileRoute('/accounts')({
  component: Accounts,
  staticData: { nav: { label: 'Accounts', group: 'setup', order: 30, member: { group: 'reports', order: 60 } } },
})

type Account = { id: number; name: string; accountNumber: string }

/** The id of an Account's Rename button, which focus goes back to when its rename form is closed. */
const renameId = (id: number) => `account-${id}-rename`
/** The id of its rename panel, which the button controls. */
const panelId = (id: number) => `account-${id}-panel`

function Accounts() {
  const { data: me } = useQuery(meQuery)
  const { data: accounts, error } = useQuery(accountsQuery)
  const [renaming, setRenaming] = useState<number | null>(null)

  // Back to the row's Rename button when the form is closed, saved or not.
  const focusBack = useFocusBack(renaming)
  // The name typed into a form and not saved stays until that form is saved or cancelled, whichever form is open and whichever layout (table or cards) it is in.
  const drafts = useDrafts<string>()
  const closeForm = (id: number) => {
    drafts.set(id, null)
    focusBack(renameId(id))
    setRenaming(null)
  }

  const columns: Column<Account>[] = [
    { key: 'name', header: 'Name', cell: (account) => account.name },
    { key: 'number', header: 'Account number', cell: (account) => <span className="tabular-nums">{account.accountNumber}</span> },
  ]
  if (me?.role === 'admin')
    columns.push({
      key: 'actions',
      header: 'Action',
      align: 'end',
      // One action, so a button named for it and not a menu; the form it opens is a panel under the row.
      cell: (account) => (
        <RowButton
          id={renameId(account.id)}
          label="Rename"
          name={`Rename ${account.name}`}
          open={renaming === account.id}
          controls={panelId(account.id)}
          onPress={() => (renaming === account.id ? focusPanel(panelId(account.id)) : setRenaming(account.id))}
        />
      ),
    })
  const renamingAccount = me?.role === 'admin' ? accounts?.find((account) => account.id === renaming) : undefined

  return (
    <>
      <h1 className="text-2xl font-semibold">Accounts</h1>
      {error ? (
        <p role="alert" className="mt-2">Fernledger couldn't load the Accounts. Reload the page to try again.</p>
      ) : !accounts ? (
        <p role="status" className="mt-2">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="mt-2">There are no Accounts yet. An Account is added the first time you import a file for it.</p>
      ) : (
        <div className="mt-4">
          <ResponsiveTable
            caption="Accounts"
            columns={columns}
            rows={accounts}
            getRowKey={(account) => account.id}
            expanded={
              renamingAccount && {
                after: renamingAccount.id,
                content: (
                  <RenameForm
                    key={renamingAccount.id}
                    id={renamingAccount.id}
                    name={renamingAccount.name}
                    drafts={drafts}
                    onDone={() => closeForm(renamingAccount.id)}
                  />
                ),
              }
            }
          />
        </div>
      )}
    </>
  )
}

function RenameForm({ id, name, drafts, onDone }: { id: number; name: string; drafts: Drafts<string>; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(() => drafts.get(id) ?? name)
  useEffect(() => {
    drafts.set(id, value === name ? null : value)
  }, [value, name, drafts, id])
  const rename = useMutation({
    mutationFn: async () => {
      const res = await api.accounts[':id'].$patch({ param: { id: String(id) }, json: { name: value } })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      await queryClient.invalidateQueries({ queryKey: ['balances'] })
      await queryClient.invalidateQueries({ queryKey: ['balance-checks'] })
      onDone()
    },
  })

  return (
    <RowPanel id={panelId(id)} title={`Rename ${name}`}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          rename.mutate()
        }}
      >
        <div>
          <label htmlFor={`rename-${id}`} className="block font-medium">
            Account name
          </label>
          <Input id={`rename-${id}`} value={value} maxLength={60} required onChange={(event) => setValue(event.target.value)} />
        </div>
        <Button type="submit" size="touch" disabled={rename.isPending || !value.trim()}>
          Save name
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        {rename.isError && <p role="alert" className="basis-full font-medium text-destructive">The name could not be saved. Try again.</p>}
      </form>
    </RowPanel>
  )
}
