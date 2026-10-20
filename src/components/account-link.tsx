import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Status } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { akahuAccountLabel, akahuAccountsQuery, describeAkahuFailure } from '@/lib/akahu'
import { api } from '@/lib/api'
import { featuresQuery } from '@/lib/features'
import { HttpError } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'

/**
 * The Account Link (spec 29): which Akahu account each Account receives its daily Sync from.
 *
 * It sits on Settings beside the Cutover Dates on purpose. A linked Account with no Cutover Date is not synced at all
 * (worker/sync.ts), so the two belong within sight of each other, and the warning below points at the control that fixes it.
 *
 * **The list of Akahu accounts is not fetched as the page loads.** Asking contacts Akahu, so nothing is asked until the Admin
 * presses the button for it. Until then the section shows what each Account is linked to from the Accounts list, which the
 * page already has.
 *
 * While Akahu Sync isn't set up the section says so in the Worker's own words, as the D1 usage bar and "Run a Sync now" do,
 * and makes no request (ADR 0008, ADR 0010).
 */
export function AccountLink() {
  const { data: features } = useQuery(featuresQuery)
  const { data: accounts } = useQuery(accountsQuery)
  const on = features?.find((candidate) => candidate.id === 'akahu-sync')?.enabled === true
  const heading = useId()
  // Set by the button, never on load: this is what lets the query contact Akahu.
  const [asked, setAsked] = useState(false)
  const akahu = useQuery({ ...akahuAccountsQuery, enabled: on && asked })

  if (!features || !accounts) return null

  return (
    <section aria-labelledby={heading} className="mt-10 max-w-xl">
      <h2 id={heading} className="text-lg font-semibold">
        Akahu Sync
      </h2>
      {!on ? (
        // What to add is said once on this screen, in Setup needed below, so it is not repeated here (as "Run a Sync now" does not).
        <p className="mt-3">Akahu Sync isn't set up yet, so there is nothing to link to. Setup needed, below, says what to add.</p>
      ) : accounts.length === 0 ? (
        <p className="mt-3">There are no Accounts yet. An Account is added the first time you import a file for it, and linked to Akahu after that.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            A linked Account receives its Transactions from Akahu each morning, from its Cutover Date onwards. Import a file for an Account before linking it: an Account with no Cutover Date is not
            synced.
          </p>
          {!asked ? (
            <Button type="button" size="touch" className="mt-3" onClick={() => setAsked(true)}>
              Show my Akahu accounts
            </Button>
          ) : akahu.isPending ? (
            <p className="mt-3" role="status">
              Asking Akahu…
            </p>
          ) : akahu.isError ? (
            <p className="mt-3" role="alert">
              <Status tone="danger">{describeAkahuFailure(akahu.error instanceof HttpError ? akahu.error.reason : undefined)}</Status>
            </p>
          ) : null}
          <ul className="mt-4 space-y-5">
            {accounts.map((account) => (
              <li key={account.id}>
                <LinkForm account={account} choices={akahu.data ?? null} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

type AccountRow = { id: number; name: string; cutoverDate: string | null; akahuAccountId: string | null }
type AkahuAccount = { _id: string; name: string; formatted_account?: string }

/** One Account's link. The select appears only once the Admin has asked for the list; before that the state is still shown. */
function LinkForm({ account, choices }: { account: AccountRow; choices: AkahuAccount[] | null }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(account.akahuAccountId ?? '')
  const save = useMutation({
    mutationFn: async (akahuAccountId: string | null) => {
      const res = await api.accounts[':id']['akahu-link'].$put({ param: { id: String(account.id) }, json: { akahuAccountId } })
      // 409 is the one failure with something useful to say: that Akahu account already feeds another Account.
      if (!res.ok) throw new HttpError(res.status)
      return akahuAccountId
    },
    onSuccess: async (akahuAccountId) => {
      setValue(akahuAccountId ?? '')
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['balances'] }) // the Balances table's Sync column follows the link
    },
  })
  const selectId = `akahu-link-${account.id}`
  // The Admin can link an Account with no Cutover Date, and Sync will skip it until one is set. Saying so is better than
  // refusing: the Cutover Date is a few centimetres up the same screen, and the Import offers to set it.
  const noCutover = account.cutoverDate === null
  // A linked Account whose Akahu account is not in the list: the list is what the user token can see now, so this is an Akahu
  // account that has gone away. Naming it as "no longer offered" is more honest than showing the row as unlinked.
  const missing = account.akahuAccountId !== null && choices !== null && !choices.some((choice) => choice._id === account.akahuAccountId)

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate(value || null)
      }}
    >
      {choices !== null ? (
        <label htmlFor={selectId} className="block font-medium">
          Akahu account for {account.name}
        </label>
      ) : (
        <p className="font-medium">Akahu account for {account.name}</p>
      )}
      <p className="text-sm text-muted-foreground">
        {account.akahuAccountId === null ? 'Not linked. This Account takes Transactions from imported files only.' : 'Linked. This Account is synced from Akahu each morning.'}
      </p>
      {missing && (
        <p role="alert">
          <Status tone="warning">Akahu no longer offers the account this is linked to. Its Transactions are kept; choose another account, or unlink it.</Status>
        </p>
      )}
      {account.akahuAccountId !== null && noCutover && (
        <p role="alert">
          <Status tone="warning">This Account has no Cutover Date, so Sync skips it. Set one above, or import a file and take the offer.</Status>
        </p>
      )}
      {/* Choosing needs the list; unlinking does not. Unlink is offered whenever the Account is linked, so an Admin whose tokens
          have been revoked — which is exactly when the list cannot be read — can still stop the daily Sync. */}
      {(choices !== null || account.akahuAccountId !== null) && (
        <div className="flex flex-wrap items-center gap-2">
          {choices !== null && (
            <>
              <Select
                id={selectId}
                className="w-auto border-foreground/60"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value)
                  save.reset()
                }}
              >
                <option value="">Not linked</option>
                {choices.map((choice) => (
                  <option key={choice._id} value={choice._id}>
                    {akahuAccountLabel(choice)}
                  </option>
                ))}
              </Select>
              <Button type="submit" size="touch" disabled={save.isPending || value === (account.akahuAccountId ?? '')}>
                Save Akahu account
              </Button>
            </>
          )}
          {account.akahuAccountId !== null && (
            <Button type="button" size="touch" variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)} aria-label={`Unlink ${account.name} from Akahu`}>
              Unlink
            </Button>
          )}
        </div>
      )}
      {/* Unlinking stops the daily Sync and deletes nothing: what Sync already brought in stays. */}
      {account.akahuAccountId !== null && <p className="text-sm text-muted-foreground">Unlinking stops the daily Sync. The Transactions it already brought in are kept.</p>}
      <p role="status">{save.isSuccess ? 'Akahu account saved.' : ''}</p>
      {save.isError && (
        <p role="alert">
          <Status tone="danger">
            {save.error instanceof HttpError && save.error.status === 409
              ? 'That Akahu account is already linked to another Account. Unlink it there first.'
              : 'The Akahu account could not be saved. Try again.'}
          </Status>
        </p>
      )}
    </form>
  )
}
