import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type ChangeEvent } from 'react'
import { Status } from '@/components/status'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { featuresQuery } from '@/lib/features'
import { formatDate } from '@/lib/format'
import { HttpError, meQuery } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { saveSettings, SettingsRejected, settingsQuery, type Settings } from '@/lib/settings'

export const Route = createFileRoute('/settings')({
  component: SettingsScreen,
  staticData: { nav: { label: 'Settings', adminOnly: true, order: 90 } },
})

const FIELD_LABELS: Record<keyof Settings, string> = {
  app_title: 'App title',
  about_contact: 'Who to contact about this data',
  about_retention: 'How long the data is kept',
}

const inputStyle =
  'mt-1 block w-full min-h-11 rounded-lg border border-foreground/60 bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive aria-invalid:border-2'

const dateStyle =
  'min-h-11 rounded-lg border border-foreground/60 bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function SettingsScreen() {
  const { data: me } = useQuery(meQuery)
  // Hiding the navigation is a courtesy; the API refuses a Member's write whatever the screen shows.
  if (!me) return null
  return (
    <>
      <h1 className="text-2xl font-semibold">Settings</h1>
      {me.role === 'admin' ? <AdminSettings /> : <p className="mt-2">Only the Admin can change settings.</p>}
    </>
  )
}

function AdminSettings() {
  const { data: settings, isError } = useQuery(settingsQuery)
  if (isError) return <p className="mt-2">Fernledger couldn't load the settings. Reload the page to try again.</p>
  if (!settings) return null
  return (
    <>
      <SettingsForm saved={settings} />
      <CutoverDates />
      <SetupNeeded />
    </>
  )
}

function SettingsForm({ saved }: { saved: Settings }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState(saved)
  // Null until a save fails; then the Settings that weren't accepted (none when the failure wasn't about a value).
  const [rejected, setRejected] = useState<string[] | null>(null)
  const save = useMutation({
    mutationFn: saveSettings,
    onSuccess: (now) => {
      setValues(now)
      queryClient.setQueryData(settingsQuery.queryKey, now)
    },
    onError: (error) => setRejected(error instanceof SettingsRejected ? error.fields : []),
  })

  const invalid = (key: keyof Settings) => rejected?.includes(key) ?? false
  const field = (key: keyof Settings) => ({
    id: key,
    name: key,
    value: values[key],
    'aria-invalid': invalid(key) || undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues({ ...values, [key]: event.target.value })
      // Editing again ends the last result, so saving once more announces "Settings saved." afresh.
      save.reset()
    },
  })

  return (
    <form
      noValidate
      className="mt-4 max-w-xl space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        setRejected(null)
        // The Worker checks too; this saves the Admin a round trip for the one value that can't be blank.
        if (!values.app_title.trim()) return setRejected(['app_title'])
        save.mutate(values)
      }}
    >
      <p>
        The Admin is set when Fernledger is deployed and can't be changed here.
      </p>
      <div>
        <label htmlFor="app_title" className="font-medium">
          {FIELD_LABELS.app_title}
        </label>
        <input {...field('app_title')} type="text" maxLength={60} className={inputStyle} aria-describedby="app_title-hint" />
        <p id="app_title-hint" className="mt-1 text-sm text-muted-foreground">
          Shown in the header, and will be shown on Reports. For example, "Mum's finances".
        </p>
      </div>
      <fieldset className="space-y-6">
        <legend className="text-lg font-semibold">About your data</legend>
        <p className="text-sm text-muted-foreground">Every Member will see these on the About your data page.</p>
        <div>
          <label htmlFor="about_contact" className="font-medium">
            {FIELD_LABELS.about_contact}
          </label>
          <textarea {...field('about_contact')} rows={3} maxLength={500} className={inputStyle} />
        </div>
        <div>
          <label htmlFor="about_retention" className="font-medium">
            {FIELD_LABELS.about_retention}
          </label>
          <textarea {...field('about_retention')} rows={3} maxLength={500} className={inputStyle} />
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" size="touch" disabled={save.isPending}>
          Save settings
        </Button>
        {/* Always in the page, so a screen reader announces the text when it appears. */}
        <p role="status">{save.isSuccess && rejected === null ? 'Settings saved.' : ''}</p>
      </div>
      {rejected !== null && (
        <p role="alert" className="font-medium text-destructive">
          {rejected.length > 0
            ? `Settings weren't saved. Check: ${rejected.map((key) => FIELD_LABELS[key as keyof Settings] ?? key).join(', ')}.`
            : "Settings weren't saved. Try again."}
        </p>
      )}
    </form>
  )
}

/** Each Account's Cutover Date (ADR 0003), with a plain explanation of what it does. */
function CutoverDates() {
  const { data: accounts, isError } = useQuery(accountsQuery)
  return (
    <section aria-labelledby="cutover-dates" className="mt-10 max-w-xl">
      <h2 id="cutover-dates" className="text-lg font-semibold">
        Cutover Dates
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A Cutover Date is the day an Account stops taking Transactions from imported files. Imports cover the dates before it, Sync (the daily pull from Akahu) covers it and later, and an Import skips every row dated on or after it. Setting or clearing it deletes nothing already saved: imported rows already saved on or after the date stay, to remove them, use "Replace imported history" on the Import screen. Leave it blank if the Account is not synced with Akahu. When you import a file, Fernledger offers the file's last date as the Cutover Date.
      </p>
      {isError ? (
        <p role="alert" className="mt-3">
          Fernledger couldn't load the Accounts. Reload the page to try again.
        </p>
      ) : !accounts ? null : accounts.length === 0 ? (
        <p className="mt-3">There are no Accounts yet. An Account is added the first time you import a file for it.</p>
      ) : (
        <ul className="mt-3 space-y-5">
          {accounts.map((account) => (
            <li key={account.id}>
              <CutoverForm id={account.id} name={account.name} cutoverDate={account.cutoverDate} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CutoverForm({ id, name, cutoverDate }: { id: number; name: string; cutoverDate: string | null }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(cutoverDate ?? '')
  const save = useMutation({
    mutationFn: async (date: string | null) => {
      const res = await api.accounts[':id']['cutover-date'].$put({ param: { id: String(id) }, json: { cutoverDate: date } })
      if (!res.ok) throw new HttpError(res.status)
      return date
    },
    onSuccess: async (date) => {
      setValue(date ?? '')
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })
  const inputId = `cutover-${id}`
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate(value || null)
      }}
    >
      <label htmlFor={inputId} className="block font-medium">
        Cutover Date for {name}
      </label>
      <p className="text-sm text-muted-foreground">{cutoverDate ? `Now ${formatDate(cutoverDate)}.` : 'None set.'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="date"
          value={value}
          className={dateStyle}
          onChange={(event) => {
            setValue(event.target.value)
            save.reset()
          }}
        />
        <Button type="submit" size="touch" disabled={save.isPending || value === (cutoverDate ?? '')}>
          Save Cutover Date
        </Button>
        {cutoverDate && (
          <Button type="button" size="touch" variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)} aria-label={`Clear the Cutover Date for ${name}`}>
            Clear
          </Button>
        )}
      </div>
      <p role="status">{save.isSuccess ? 'Cutover Date saved.' : ''}</p>
      {save.isError && (
        <p role="alert">
          <Status tone="danger">The Cutover Date could not be saved. Try again.</Status>
        </p>
      )}
    </form>
  )
}

/** Features that are switched off for want of configuration, with what to do. Shown only to the Admin. */
function SetupNeeded() {
  const { data: features } = useQuery(featuresQuery)
  const off = features?.filter((feature) => !feature.enabled) ?? []
  if (!off.length) return null
  return (
    <section aria-labelledby="setup-needed" className="mt-10 max-w-xl">
      <h2 id="setup-needed" className="text-lg font-semibold">
        Setup needed
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">These features are switched off until you do the following. Everything else keeps working, and an optional feature can stay off if you don't need it.</p>
      <ul className="mt-3 space-y-3">
        {off.map((feature) => (
          <li key={feature.id}>
            <span className="font-medium">{feature.name}</span>
            <br />
            {feature.message}
          </li>
        ))}
      </ul>
    </section>
  )
}
