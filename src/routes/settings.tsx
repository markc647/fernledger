import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { featuresQuery } from '@/lib/features'
import { meQuery } from '@/lib/me'
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
