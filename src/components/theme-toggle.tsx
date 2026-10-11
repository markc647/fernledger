import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { parsePreference, resolveTheme, THEME_STORAGE_KEY, type ThemePreference } from '@/lib/theme'

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const readPreference = () => {
  try {
    return parsePreference(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system' // storage blocked: follow the device
  }
}

/** Light and dark follow the device until the person picks one. The choice is remembered on this device only. */
export function ThemeToggle() {
  const [preference, setPreference] = useState(readPreference)

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.classList.toggle('dark', resolveTheme(preference, query.matches) === 'dark')
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [preference])

  const choose = (value: ThemePreference) => {
    setPreference(value)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value)
    } catch {
      // Storage blocked: the choice applies until the page is closed.
    }
  }

  return (
    <div role="group" aria-label="Colour theme" className="flex flex-wrap gap-1">
      {OPTIONS.map(({ value, label }) => (
        <Button
          key={value}
          size="touch"
          variant={preference === value ? 'default' : 'outline'}
          aria-pressed={preference === value}
          onClick={() => choose(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}
