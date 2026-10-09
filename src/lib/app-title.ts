import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'

/** What the header says if the app title can't be loaded. The Worker's default is the same word. */
export const FALLBACK_APP_TITLE = 'Fernledger'

/**
 * The app title the Admin set in Settings (or "Fernledger" until they do). The Settings screen should invalidate
 * this key after saving a new title so the header updates without a reload.
 */
export const appTitleQuery = queryOptions({
  queryKey: ['app-title'],
  retry: false,
  queryFn: async () => {
    const res = await api['app-title'].$get()
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()).title
  },
})
