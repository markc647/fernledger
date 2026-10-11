import type { Role } from './role'

/**
 * A route opts into the navigation with `staticData: { nav: { label, ... } }` in its own route file
 * (see src/routes/settings.tsx), so adding a page never means editing a shared list.
 * Hiding is a courtesy: the API enforces Admin-only on every request.
 */
export type NavMeta = {
  label: string
  /** What the Admin's navigation calls it instead, for an address that is a different page for the Admin (the Dashboard is where the Summary is). */
  adminLabel?: string
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

/** The links this reader sees, in order, each by the label this reader sees it by. */
export const navFor = <To extends string>(entries: NavEntry<To>[], role: Role | undefined) =>
  entries
    .filter((entry) => !entry.adminOnly || role === 'admin')
    .map((entry) => ({ ...entry, label: role === 'admin' && entry.adminLabel ? entry.adminLabel : entry.label }))
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || a.label.localeCompare(b.label))
