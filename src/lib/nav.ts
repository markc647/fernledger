import type { Role } from './role'

const GROUPS = [
  { id: 'transactions', title: 'Transactions' },
  { id: 'reports', title: 'Reports' },
  // A Member never sees this group. It hides the group from the sidebar only: the pages in it keep their own access, and the API enforces the Admin on every change.
  { id: 'setup', title: 'Set up', adminOnly: true },
  { id: 'help', title: 'Help' },
] as const

export type NavGroupId = (typeof GROUPS)[number]['id']

/** The sidebar's groups, in the order it shows them. A group's icon is in src/components/app-sidebar.tsx, which fails to compile if one is missing. */
export const NAV_GROUPS: readonly { id: NavGroupId; title: string; adminOnly?: boolean }[] = GROUPS

/**
 * A route opts into the navigation with `staticData: { nav: { label, group, ... } }` in its own route file
 * (see src/routes/settings.tsx), so adding a page never means editing a shared list.
 * Hiding is a courtesy: the API enforces Admin-only on every request.
 */
export type NavMeta = {
  label: string
  /** What the Admin's navigation calls it instead, for an address that is a different page for the Admin (the Dashboard is where the Summary is). */
  adminLabel?: string
  adminOnly?: boolean
  /** The sidebar group that lists it. None: a link of its own at the top (the Summary, which is the Admin's Dashboard). */
  group?: NavGroupId
  /** Lower comes first within its group (default 50); ties sort alphabetically. */
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

/** What the sidebar shows: a link on its own, or a group of links under a title. */
export type NavSection<To extends string = string> =
  | { kind: 'link'; id: string; title: string; to: To }
  | { kind: 'group'; id: NavGroupId; title: string; items: { to: To; label: string }[] }

/** The sidebar for this reader: links of their own first, then each group that has something to show them, in `NAV_GROUPS` order. */
export function navSections<To extends string>(entries: NavEntry<To>[], role: Role | undefined): NavSection<To>[] {
  const seen = navFor(entries, role)
  const links = seen.filter((entry) => !entry.group).map((entry): NavSection<To> => ({ kind: 'link', id: entry.to, title: entry.label, to: entry.to }))
  const groups = NAV_GROUPS.filter((group) => !group.adminOnly || role === 'admin').flatMap((group): NavSection<To>[] => {
    const items = seen.filter((entry) => entry.group === group.id).map(({ to, label }) => ({ to, label }))
    return items.length > 0 ? [{ kind: 'group', id: group.id, title: group.title, items }] : []
  })
  return [...links, ...groups]
}

// "/" is the Summary only; "/transactions" is also the page of a Transaction ("/transactions/42") but not "/transactions-old".
const covers = (to: string, pathname: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`))

/** Where a page sits, for the breadcrumb and for which group opens: the group (none for a link on its own) and the page, from the longest address that covers `pathname`. */
export function trailFor(sections: NavSection[], pathname: string): { group?: string; groupId?: NavGroupId; page?: string; to?: string } {
  let best: { group?: string; groupId?: NavGroupId; page: string; to: string } | undefined
  for (const section of sections) {
    const pages = section.kind === 'link' ? [{ to: section.to, label: section.title }] : section.items
    for (const { to, label } of pages) {
      if (covers(to, pathname) && (!best || to.length > best.to.length)) {
        best = section.kind === 'link' ? { page: label, to } : { group: section.title, groupId: section.id, page: label, to }
      }
    }
  }
  return best ?? {}
}
