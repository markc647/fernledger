import type { DeviceStorage } from './device-storage'

/** `system` is no one's choice: it is what a device has until the toggle is first used. */
export type ThemePreference = 'system' | 'light' | 'dark'

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'fernledger-theme'

export function parsePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/** What the toggle switches to. */
export const otherTheme = (theme: Theme): Theme => (theme === 'dark' ? 'light' : 'dark')

/** What the person chose on this device; `system` while they haven't, or when storage is blocked. */
export function loadThemePreference(storage: DeviceStorage): ThemePreference {
  try {
    return parsePreference(storage?.getItem(THEME_STORAGE_KEY) ?? null)
  } catch {
    return 'system' // storage blocked: follow the device
  }
}

/** Remembers the choice on this device. False when it couldn't be saved; the theme still applies until the page closes. */
export function saveThemePreference(theme: Theme, storage: DeviceStorage) {
  if (!storage) return false
  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}
