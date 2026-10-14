import { useEffect, useState } from 'react'
import { deviceStorage } from './device-storage'
import { loadThemePreference, otherTheme, resolveTheme, saveThemePreference, type ThemePreference } from './theme'
import { useMediaQuery } from './use-media-query'

/**
 * Follows the device until the person uses the toggle; after that their choice is remembered on this device. It is used by the layout, so it is always mounted:
 * a device that goes dark at sunset changes the page whether or not the toggle is on screen (it is in a menu on a phone). public/theme-init.js applies it before
 * first paint.
 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => loadThemePreference(deviceStorage()))
  const deviceIsDark = useMediaQuery('(prefers-color-scheme: dark)')
  const theme = resolveTheme(preference, deviceIsDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const toggle = () => {
    const next = otherTheme(theme)
    setPreference(next)
    saveThemePreference(next, deviceStorage())
  }

  return { theme, toggle }
}
