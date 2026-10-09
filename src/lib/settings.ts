import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'

/** What the header says if the app title can't be loaded. The Worker's default (`DEFAULT_SETTINGS`) is the same word. */
export const FALLBACK_APP_TITLE = 'Fernledger'

/** The app title and the About-your-data fields. Anyone signed in can read them; only the Admin can change them. */
export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: async () => {
    const res = await api.settings.$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
})

export type Settings = Awaited<ReturnType<NonNullable<typeof settingsQuery.queryFn>>>

/** The Worker refused the values; `fields` names the Settings it didn't accept. */
export class SettingsRejected extends Error {
  fields: string[]
  constructor(fields: string[]) {
    super('Settings were refused')
    this.fields = fields
  }
}

/** Saves the Settings and returns them as they now stand. */
export async function saveSettings(settings: Settings): Promise<Settings> {
  const res = await api.settings.$patch({ json: settings })
  if (res.ok) return res.json()
  const body = await res.json().catch(() => null)
  if (res.status === 400 && body && 'fields' in body) throw new SettingsRejected(body.fields)
  throw new HttpError(res.status)
}
