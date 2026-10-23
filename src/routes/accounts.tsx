import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { HelpHeading, PageHeading } from '@/components/help-sheet'
import { RowButton, useFocusBack } from '@/components/row-actions'
import { Status } from '@/components/status'
import { focusPanel, RowPanel, useDrafts, type Drafts } from '@/components/row-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isGeneratedKey } from '@/lib/account-key'
import { akahuWords } from '@/lib/akahu'
import { formatBalance, formatDateTime, isMoment } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { api } from '@/lib/api'
import type { InferResponseType } from 'hono/client'

export const Route = createFileRoute('/accounts')({
  component: Accounts,
  staticData: { nav: { label: 'Accounts', group: 'setup', order: 30, member: { group: 'reports', order: 60 } } },
})

// What Akahu said about a linked Account, as Sync last kept it (worker/akahu-details.ts), with Fernledger's own name, number and Sync state.
// Taken from the Worker's own answer rather than written out again: a field the Accounts list starts sending is then a field this page has,
// and the four that went unshown until ticket 42 could not happen twice. The logo URL Akahu gives is not in that answer at all (ADR 0010).
type Account = InferResponseType<typeof api.accounts.$get>[number]

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
    {
      key: 'number',
      header: 'Account number',
      // An Account whose bank prints no number has a key Fernledger generated, which is never shown as the bank's own (ADR 0017).
      cell: (account) =>
        isGeneratedKey(account.accountNumber) ? <span className="text-muted-foreground">None from the bank</span> : <span className="tabular-nums">{account.accountNumber}</span>,
    },
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
      <PageHeading help={me?.role === 'admin' && <AccountsHelp />}>Accounts</PageHeading>
      {error ? (
        <p role="alert" className="mt-2">Fernledger couldn't load the Accounts. Reload the page to try again.</p>
      ) : !accounts ? (
        <p role="status" className="mt-2">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="mt-2">There are no Accounts yet. An Account is added the first time you import a file for it, or below for a credit card, whose bank prints no account number.</p>
      ) : (
        <div className="mt-4">
          <ResponsiveTable
            caption="Accounts"
            columns={columns}
            rows={accounts}
            getRowKey={(account) => account.id}
            /* What Akahu says sits under the Account, across the whole table, rather than in a column of its own: its label-and-value lines are too wide
               to share the row, and squeezed into a column they wrapped the Name, the Account number and the Rename button (A1). */
            detail={(account) => (
              <>
                {/* The row under the Account has no column heading of its own, so it says whose details these are for a screen reader. */}
                <span className="sr-only">From Akahu, {account.name}</span>
                <AkahuDetails account={account} />
              </>
            )}
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
      {me?.role === 'admin' && <AddCardAccount />}
    </>
  )
}

/** What a reader reads once about this page: why a credit card is added here and not by an Import (CODING_STANDARDS.md#ui). */
function AccountsHelp() {
  return (
    <>
      <p>Every Account the bank gives a number for is added the first time you import a file for it, and this page is where you see and rename them.</p>
      <HelpHeading>Add a Credit Card Account</HelpHeading>
      <p>
        A credit card has no account number from the bank, and its card number is not one either: a card is reissued on fraud or expiry, so an Account keyed on it would split in two. Fernledger gives
        the Account a key of its own, which you never type and are never shown.
      </p>
      <p>Add the card by name, then import the card's CSV or link the Account to Akahu in Settings. An Import of a card's file asks which Account it is for, because the file does not say.</p>
    </>
  )
}

/**
 * Adds an Account for a credit card. A card's bank prints no account number and its card number is not one (a reissue would
 * split the Account in two), so Fernledger gives the Account a key of its own and the Admin types only the name (ADR 0017).
 * Every other Account is still created by importing a file for it, which is where its number comes from.
 */
function AddCardAccount() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [added, setAdded] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: async () => {
      const res = await api.accounts.$post({ json: { name: name.trim() } })
      if (!res.ok) throw new HttpError(res.status)
      return (await res.json()).name
    },
    onSuccess: async (addedName) => {
      setName('')
      setAdded(addedName)
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  return (
    <section aria-labelledby="add-card" className="mt-8 max-w-xl">
      <h2 id="add-card" className="text-xl font-semibold">
        Add a Credit Card Account
      </h2>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <div>
          {/* Not "Account name": the Rename panel on this page has one of those, and two fields of the same name on a page are two the same to a screen reader. */}
          <label htmlFor="card-name" className="block font-medium">
            Credit card Account name
          </label>
          <Input id="card-name" value={name} maxLength={60} required aria-describedby="card-name-hint" onChange={(event) => setName(event.target.value)} />
          <p id="card-name-hint" className="mt-1 text-sm text-muted-foreground">
            Yours to choose, and you can change it later.
          </p>
        </div>
        <Button type="submit" size="touch" disabled={add.isPending || !name.trim()}>
          Add the Account
        </Button>
        {add.isError && <p role="alert" className="basis-full font-medium text-destructive">The Account could not be added. Try again.</p>}
      </form>
      {added !== null && (
        <p role="status" className="mt-2">
          Added {added}. Its Transactions come from the card's CSV or from Akahu.
        </p>
      )}
    </section>
  )
}

/**
 * What Akahu says about the Account: whether its Link is broken, the bank, Akahu's own name for it (a wrong link shows at a glance), its type and status, its balance,
 * when Akahu last read the bank for each part and when Fernledger last Synced it, in NZ time.
 *
 * A broken Link is said first, because nothing under it is current (spec 32): Akahu has stopped listing the account, so what
 * follows is what the last Sync that still found it stored. The details stay on show under it, Akahu's own name among them,
 * because that name is how the Admin tells which Akahu account this was when they come to link it again. Nothing of the
 * Account's is deleted for a broken Link, and re-linking is on the Settings page.
 */
function AkahuDetails({ account }: { account: Account }) {
  // A page that does not know the Account is linked (an older answer) reads the same as one that is not.
  if (!account.akahuAccountId) return <span className="text-muted-foreground">Not linked to Akahu</span>
  const broken = (account.akahuMissingSince ?? null) !== null ? <BrokenLink account={account} /> : null
  if (account.akahuName === null)
    return (
      <>
        {broken}
        <span>Linked to Akahu. The next Sync will read its details.</span>
      </>
    )
  // `?? null` throughout: an answer from before a field was stored leaves it undefined, and a balance or a time that is not one
  // must read as "Akahu did not give one" rather than fail the whole screen (the same guard `isMoment` gives the times).
  const current = account.akahuBalanceCurrentCents ?? null
  const available = account.akahuBalanceAvailableCents ?? null
  const currency = account.akahuBalanceCurrency ?? null
  const balance =
    current === null
      ? 'Akahu did not give one'
      : [formatBalance(current), currency, available !== null && available !== current ? `(${formatBalance(available)} available)` : null].filter(Boolean).join(' ')
  // Akahu's own `refreshed` times: when Akahu last read the bank, which is not when Fernledger last Synced, and does not move until Akahu reads it again.
  const read = (
    [
      ['Balance', account.akahuRefreshedBalanceAt],
      ['Account details', account.akahuRefreshedMetaAt],
      ['Transactions', account.akahuRefreshedTransactionsAt],
    ] as const
  ).filter(([, at]) => isMoment(at))
  return (
    <>
      {broken}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
        <DetailLine term="Bank">{account.akahuConnectionName}</DetailLine>
        <DetailLine term="Akahu's connection type">{account.akahuConnectionType && akahuWords(account.akahuConnectionType)}</DetailLine>
        <DetailLine term="Akahu's connection ID">{account.akahuConnectionId}</DetailLine>
        <DetailLine term="Akahu's name">{account.akahuName}</DetailLine>
        <DetailLine term="Akahu's account number">{account.akahuFormattedAccount}</DetailLine>
        <DetailLine term="Type">{account.akahuType && akahuWords(account.akahuType)}</DetailLine>
        <DetailLine term="Status">{account.akahuStatus && akahuWords(account.akahuStatus)}</DetailLine>
        {/* Akahu saying the Account can do nothing is not Akahu saying nothing about it: an empty list has a line, and reads as none. */}
        <DetailLine term="Akahu's attributes">{account.akahuAttributes && (account.akahuAttributes.length === 0 ? 'None' : account.akahuAttributes.map(akahuWords).join(', '))}</DetailLine>
        <DetailLine term="Balance">{balance}</DetailLine>
        <DetailLine term="Last Sync">{isMoment(account.akahuSyncedAt) ? formatDateTime(account.akahuSyncedAt) : 'Never synced'}</DetailLine>
        {/* One part to a line: three times run together read as one long string, and it is three separate readings of the bank. */}
        <DetailLine term="Akahu last read the bank">
          {read.length === 0
            ? null
            : read.map(([what, at]) => (
                <span key={what} className="block">
                  {what}: {formatDateTime(at!)}
                </span>
              ))}
        </DetailLine>
      </dl>
    </>
  )
}

/**
 * An Account Akahu has stopped listing: since when, and what to do about it. Only the Admin is told what to do (spec 60). What
 * Akahu said about the Account follows it, as the last Sync that found it left it.
 */
function BrokenLink({ account }: { account: Account }) {
  const { data: me } = useQuery(meQuery)
  return (
    <div className="mb-2">
      <Status tone="danger">Account Link broken</Status>
      <p className="mt-1 text-muted-foreground">
        {/* Since when, where the time is known: an answer from before it was stored has none, and the sentence stands without it. */}
        Akahu has stopped listing this account{isMoment(account.akahuMissingSince) ? ` since ${formatDateTime(account.akahuMissingSince)}` : ''}. No Transaction has been removed, and the Transactions
        already held are still here.
      </p>
      {me?.role === 'admin' && (
        <p className="mt-1">
          Reconnect the bank in Akahu, then{' '}
          <Link to="/settings" className="underline underline-offset-4">
            link this Account again in Settings
          </Link>
          .
        </p>
      )}
    </div>
  )
}

/** One line of the details; a thing Akahu did not give has no line. */
function DetailLine({ term, children }: { term: string; children: ReactNode }) {
  if (!children) return null
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
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
