import { describe, expect, it } from 'vitest'
import { parsePreference, resolveTheme } from './theme'

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
