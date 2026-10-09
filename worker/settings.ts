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

/** Every Setting, with the default for any the Admin hasn't set. One query. */
export async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: SettingKey; value: string }>()
  const settings = { ...DEFAULT_SETTINGS }
  for (const { key, value } of results) if (isSettingKey(key)) settings[key] = value
  return settings
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
 * Applies the Admin's change and logs it (before and after, for the Settings that actually changed).
 * Returns the Settings as they now stand. Nothing is written when nothing changed.
 */
export async function updateSettings(db: D1Database, actor: Member, patch: SettingsPatch): Promise<Settings> {
  const current = await readSettings(db)
  const changed = SETTING_KEYS.filter((key) => patch[key] !== undefined && patch[key] !== current[key])
  if (!changed.length) return current

  const before: Partial<Settings> = {}
  const after: Partial<Settings> = {}
  for (const key of changed) {
    before[key] = current[key]
    after[key] = patch[key]
  }
  const summary = `Changed settings: ${changed.map((key) => LABELS[key]).join(', ')}`
  await recordChange(
    db,
    changed.map((key) => putSetting(db, key, patch[key]!)),
    { actor, type: 'settings', summary, before, after },
  )
  return { ...current, ...after }
}
