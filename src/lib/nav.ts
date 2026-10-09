import type { Role } from './role'

/**
 * A route opts into the navigation with `staticData: { nav: { label, ... } }` in its own route file
 * (see src/routes/settings.tsx), so adding a page never means editing a shared list.
 * Hiding is a courtesy: the API enforces Admin-only on every request.
 */
export type NavMeta = {
  label: string
  adminOnly?: boolean
  /** Lower comes first (default 50); ties sort alphabetically. */
  order?: number
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    nav?: NavMeta
  }
}
export type NavEntry<To extends string = string> = NavMeta & { to: To }

const DEFAULT_ORDER = 50

export const navFor = <To extends string>(entries: NavEntry<To>[], role: Role | undefined) =>
  entries
    .filter((entry) => !entry.adminOnly || role === 'admin')
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || a.label.localeCompare(b.label))
