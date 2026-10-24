import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * Whether a media query matches, now and as it changes. The first render already has the right answer (the page is drawn in the browser, never on a
 * server), so a layout that depends on it never draws the other one first. Prefer a CSS breakpoint where the layout alone changes; this is for what
 * must be decided in code, like whether the sidebar is a sheet.
 */
export function useMediaQuery(query: string) {
  const list = useMemo(() => window.matchMedia(query), [query])
  const subscribe = useCallback(
    (onChange: () => void) => {
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [list],
  )
  return useSyncExternalStore(subscribe, () => list.matches)
}
