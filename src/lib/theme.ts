export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'fernledger-theme'

export function parsePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}
