import { describe, expect, it } from 'vitest'
import { loadThemePreference, otherTheme, parsePreference, resolveTheme, saveThemePreference, THEME_STORAGE_KEY } from './theme'

/** A stand-in for localStorage. */
const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

/** A stand-in for storage that the browser blocks (private modes, blocked site data): every access throws. */
const blockedStorage = () => ({
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
})

describe('resolveTheme', () => {
  it('follows the device when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('lets a manual choice win over the device', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('parsePreference', () => {
  it('reads the three known values', () => {
    expect(parsePreference('light')).toBe('light')
    expect(parsePreference('dark')).toBe('dark')
    expect(parsePreference('system')).toBe('system')
  })

  it('falls back to following the device for anything else', () => {
    expect(parsePreference(null)).toBe('system')
    expect(parsePreference('')).toBe('system')
    expect(parsePreference('solarized')).toBe('system')
  })
})

describe('otherTheme', () => {
  it('is the one the toggle switches to', () => {
    expect(otherTheme('light')).toBe('dark')
    expect(otherTheme('dark')).toBe('light')
  })
})

describe('loadThemePreference and saveThemePreference', () => {
  it('remember a choice on this device', () => {
    const storage = fakeStorage()
    expect(saveThemePreference('dark', storage)).toBe(true)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(loadThemePreference(storage)).toBe('dark')
  })

  it('follow the device when nothing is saved, the saved value is junk, or storage is blocked', () => {
    expect(loadThemePreference(fakeStorage())).toBe('system')
    expect(loadThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'solarized' }))).toBe('system')
    expect(loadThemePreference(blockedStorage())).toBe('system')
    expect(loadThemePreference(undefined)).toBe('system')
  })

  it('still read a choice the three-button control saved', () => {
    expect(loadThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
    expect(loadThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'system' }))).toBe('system')
  })

  it('report, without throwing, that a choice could not be saved', () => {
    expect(saveThemePreference('light', blockedStorage())).toBe(false)
    expect(saveThemePreference('light', undefined)).toBe(false)
  })
})
