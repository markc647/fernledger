import type { FileRoutesByTo } from '@/routeTree.gen'

export type Role = 'admin' | 'member'
type NavItem = { to: keyof FileRoutesByTo; label: string; adminOnly?: true }

/** Add an item here when a feature's route file lands. Hiding is a courtesy: the API enforces Admin-only on every request. */
const NAV: NavItem[] = [
  { to: '/', label: 'Summary' },
  { to: '/settings', label: 'Settings', adminOnly: true },
]

export const navFor = (role: Role | undefined) => NAV.filter((item) => !item.adminOnly || role === 'admin')
