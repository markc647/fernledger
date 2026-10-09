import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HttpError, meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { api } from '@/lib/api'

export const Route = createFileRoute('/accounts')({
  component: Accounts,
  staticData: { nav: { label: 'Accounts', order: 30 } },
})

function Accounts() {
  const { data: me } = useQuery(meQuery)
  const { data: accounts, error } = useQuery(accountsQuery)
  const [renaming, setRenaming] = useState<number | null>(null)

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
        <div className="mt-4 overflow-x-auto" role="region" aria-label="Accounts table" tabIndex={0}>
          <table className="w-full text-left">
            <caption className="sr-only">Accounts</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pe-4 font-medium">Name</th>
                <th scope="col" className="py-2 pe-4 font-medium">Account number</th>
                {me?.role === 'admin' && (
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b">
                  <td className="py-2 pe-4">{account.name}</td>
                  <td className="py-2 pe-4 tabular-nums">{account.accountNumber}</td>
                  {me?.role === 'admin' && (
                    <td className="py-2">
                      {renaming === account.id ? (
                        <RenameForm id={account.id} name={account.name} onDone={() => setRenaming(null)} />
                      ) : (
                        <Button size="touch" variant="outline" aria-label={`Rename ${account.name}`} onClick={() => setRenaming(account.id)}>
                          Rename
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function RenameForm({ id, name, onDone }: { id: number; name: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(name)
  const rename = useMutation({
    mutationFn: async () => {
      const res = await api.accounts[':id'].$patch({ param: { id: String(id) }, json: { name: value } })
      if (!res.ok) throw new HttpError(res.status)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['transactions'] })
      onDone()
    },
  })

  return (
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
        <Input id={`rename-${id}`} value={value} maxLength={60} required autoFocus onChange={(event) => setValue(event.target.value)} />
      </div>
      <Button type="submit" size="touch" disabled={rename.isPending || !value.trim()}>
        Save name
      </Button>
      <Button type="button" size="touch" variant="outline" onClick={onDone}>
        Cancel
      </Button>
      {rename.isError && <p role="alert" className="basis-full font-medium text-destructive">The name could not be saved. Try again.</p>}
    </form>
  )
}
