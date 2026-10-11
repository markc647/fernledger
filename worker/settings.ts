import * as z from 'zod/mini'
import type { Member } from './auth'
import { recordChange } from './changelog'

// The one place that knows which Settings exist. Everything else names a Setting by SettingKey, never a raw string.
// The Admin is not a Setting: it is the ADMIN_EMAIL secret (ADR 0002).
export const SETTING_KEYS = ['app_title', 'about_contact', 'about_retention'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]
export type Settings = Record<SettingKey, string>

/** True for a Setting's key; unlike `in`, it is false for names every object has, such as `constructor`. */
export const isSettingKey = (key: string): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key)

/** What a Setting reads as until the Admin sets it. */
export const DEFAULT_SETTINGS: Settings = { app_title: 'Fernledger', about_contact: '', about_retention: '' }

/** A statement that sets a Setting. Pass it to `recordChange` so the change is logged with it. */
export const putSetting = (db: D1Database, key: SettingKey, value: string): D1PreparedStatement =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value)

/** The Setting's value, or null if it has never been set. */
export const getSetting = (db: D1Database, key: SettingKey): Promise<string | null> =>
  db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value')

/** The Settings the Admin has set, and none of the others. One query. */
async function readStored(db: D1Database): Promise<Partial<Settings>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: SettingKey; value: string }>()
  const stored: Partial<Settings> = {}
  for (const { key, value } of results) if (isSettingKey(key)) stored[key] = value
  return stored
}

/** Every Setting, with the default for any the Admin hasn't set. One query. */
export async function readSettings(db: D1Database): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readStored(db)) }
}

const LABELS: Record<SettingKey, string> = { app_title: 'app title', about_contact: 'contact', about_retention: 'retention' }

const text = (max: number) => z.string().check(z.trim(), z.maxLength(max))

/** The body of a settings change: any of the Settings, nothing else (the Admin is never a Setting). */
export const settingsPatch = z.strictObject({
  app_title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(60))),
  about_contact: z.optional(text(500)),
  about_retention: z.optional(text(500)),
})
export type SettingsPatch = z.infer<typeof settingsPatch>

/** The names of the Settings a failed validation rejected, once each. Names only: the rejected values stay out of responses. */
export const rejectedFields = (issues: readonly { path: readonly PropertyKey[] }[]): string[] => [
  ...new Set(issues.flatMap((issue) => (typeof issue.path[0] === 'string' ? [issue.path[0]] : []))),
]

/**
 * A statement that sets the Settings in `values`, but only if each Setting in `expected` still holds what it says (null for one the Admin has never set): all of
 * them or none, so a change whose read went stale writes nothing. Another request can land between a read and the write. The check is a subquery that does not depend
 * on the rows being written, which SQLite works out once, before the first of them; `changes()` after it is how many Settings it set.
 */
const putSettingsIfUnchanged = (db: D1Database, expected: Partial<Record<SettingKey, string | null>>, values: Partial<Settings>): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO settings (key, value)
       SELECT j.key, j.value FROM json_each(?1) j
       WHERE NOT EXISTS (SELECT 1 FROM json_each(?2) e WHERE (SELECT s.value FROM settings s WHERE s.key = e.key) IS NOT e.value)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify(values), JSON.stringify(expected))

/**
 * Applies the Admin's change and logs it (before and after, for the Settings that actually changed).
 * Returns the Settings as they now stand, or null when another request changed one of them between this one's read and its write: nothing is written and nothing
 * is logged then, unless the Settings are already what was asked for, which is not a change either. Nothing is written when nothing changed.
 */
export async function updateSettings(db: D1Database, actor: Member, patch: SettingsPatch): Promise<Settings | null> {
  const stored = await readStored(db)
  const current = { ...DEFAULT_SETTINGS, ...stored }
  const changed = SETTING_KEYS.filter((key) => patch[key] !== undefined && patch[key] !== current[key])
  if (!changed.length) return current

  const before: Partial<Settings> = {}
  const after: Partial<Settings> = {}
  const expected: Partial<Record<SettingKey, string | null>> = {}
  for (const key of changed) {
    before[key] = current[key]
    after[key] = patch[key]
    expected[key] = stored[key] ?? null
  }
  const summary = `Changed settings: ${changed.map((key) => LABELS[key]).join(', ')}`
  const [write] = await recordChange(db, putSettingsIfUnchanged(db, expected, after), { actor, type: 'settings', summary, before, after, onlyIfChanged: true })
  if (write!.meta.changes === 0) {
    const now = await readSettings(db)
    return changed.every((key) => now[key] === patch[key]) ? now : null
  }
  return { ...current, ...after }
}
