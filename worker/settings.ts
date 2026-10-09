// The one place that knows which Settings exist. Everything else names a Setting by SettingKey, never a raw string.
// The Admin is not a Setting: it is the ADMIN_EMAIL secret (ADR 0002).
export type SettingKey = 'app_title' | 'about_contact' | 'about_retention'

/** What the header says until the Admin sets a title (and if they clear it). */
export const DEFAULT_APP_TITLE = 'Fernledger'

/** The title to show: the stored one without surrounding spaces, or the default when it is unset or blank. */
export const appTitleOrDefault = (stored: string | null) => stored?.trim() || DEFAULT_APP_TITLE

/** A statement that sets a Setting. Pass it to `recordChange` so the change is logged with it. */
export const putSetting = (db: D1Database, key: SettingKey, value: string): D1PreparedStatement =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value)

/** The Setting's value, or null if it has never been set. */
export const getSetting = (db: D1Database, key: SettingKey): Promise<string | null> =>
  db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value')
