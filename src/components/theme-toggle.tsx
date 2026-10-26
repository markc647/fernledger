import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { otherTheme, type Theme } from '@/lib/theme'

/**
 * One button that switches between the light and dark theme, with the sun or moon it will switch to. Which theme is showing, following the device until this is first
 * used, and remembering the choice, is `useTheme` (src/lib/use-theme.ts), in the layout. The name says what pressing it does, so it carries no pressed state.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = otherTheme(theme)
  return (
    <Button variant="outline" size="icon" onClick={onToggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  )
}
