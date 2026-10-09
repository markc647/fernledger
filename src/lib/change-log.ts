import { formatDate } from './format'

/** `key` is the field as recorded (unique within an entry); `field` is its label. */
export type ChangeRow = { key: string; field: string; before: string; after: string }
export type ChangeFields = { showBefore: boolean; showAfter: boolean; rows: ChangeRow[] }

const NONE = '(none)'

/** "app_title" and "fileRows" read as "App title" and "File rows". */
const label = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Fields known to hold an NZ date (an Import's first and last Transaction). Any other text is shown as stored, even if it looks like a date. */
const DATE_KEYS = new Set(['from', 'to'])

/** A date the usual way, or the text as stored if it isn't a real date: the page must never fail to render. */
function showDate(text: string) {
  try {
    return formatDate(text)
  } catch {
    return text
  }
}

/** One recorded value in words: dates the usual way, yes/no for booleans, lists and records without braces. `key` is the field it was recorded under. */
function show(value: unknown, key?: string): string {
  if (value === null || value === undefined) return NONE
  if (value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return key !== undefined && DATE_KEYS.has(key) ? showDate(value) : value
  if (Array.isArray(value)) return value.length ? value.map((v) => show(v, key)).join(', ') : NONE
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${label(k)}: ${show(v, k)}`).join('; ')
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
    rows: keys.map((key) => ({ key, field: label(key), before: show(was?.[key], key), after: show(now?.[key], key) })),
  }
}
