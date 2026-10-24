import { readDevice, writeDevice, type DeviceStorage } from './device-storage.ts'

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
export const loadThemePreference = (storage: DeviceStorage): ThemePreference => parsePreference(readDevice(storage, THEME_STORAGE_KEY))

/** Remembers the choice on this device. False when it couldn't be saved; the theme still applies until the page closes. */
export const saveThemePreference = (theme: Theme, storage: DeviceStorage) => writeDevice(storage, THEME_STORAGE_KEY, theme)
