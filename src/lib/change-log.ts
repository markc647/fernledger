import { formatDate } from './format'

export type ChangeRow = { field: string; before: string; after: string }
export type ChangeFields = { showBefore: boolean; showAfter: boolean; rows: ChangeRow[] }

const NONE = '(none)'

/** "app_title" and "fileRows" read as "App title" and "File rows". */
const label = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One recorded value in words: dates the usual way, yes/no for booleans, lists and records without braces. */
function show(value: unknown): string {
  if (value === null || value === undefined) return NONE
  if (value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value
  if (Array.isArray(value)) return value.length ? value.map(show).join(', ') : NONE
  if (typeof value === 'object') return Object.entries(value).map(([key, v]) => `${label(key)}: ${show(v)}`).join('; ')
  return String(value)
}

/** The recorded side of an entry as fields, or null if nothing was recorded. Text that isn't JSON is kept as it is. */
function parse(json: string | null): Record<string, unknown> | null {
  if (json === null) return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    value = json
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }
}

/**
 * Lays an entry's before and after (JSON text, as stored) out field by field for the Change Log page,
 * in the order the fields were recorded: those on the before side first, then any only on the after side.
 */
export function changeFields(before: string | null, after: string | null): ChangeFields {
  const was = parse(before)
  const now = parse(after)
  const keys = [...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])]
  return {
    showBefore: was !== null,
    showAfter: now !== null,
    rows: keys.map((key) => ({ field: label(key), before: show(was?.[key]), after: show(now?.[key]) })),
  }
}
