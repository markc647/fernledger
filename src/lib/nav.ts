import type { Role } from './role'

/**
 * The sidebar's groups, in the order it shows them. A group's icon is in src/components/app-sidebar.tsx, which fails to compile if one is missing. A group with
 * `adminOnly` is not in a Member's sidebar at all (Set up): that hides the group and nothing else. The pages in it keep their own access, and the API enforces the
 * Admin on every change.
 */
export const NAV_GROUPS = [
  { id: 'transactions', label: 'Transactions', adminOnly: false },
  { id: 'reports', label: 'Reports', adminOnly: false },
  { id: 'setup', label: 'Set up', adminOnly: true },
  { id: 'help', label: 'Help', adminOnly: false },
] as const satisfies readonly { id: string; label: string; adminOnly: boolean }[]

export type NavGroupId = (typeof NAV_GROUPS)[number]['id']

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
  /** Where a Member finds it when that is not where the Admin does: Accounts is in Set up for the Admin, whose group a Member never sees, and in Reports for a Member. */
  member?: { group?: NavGroupId; order?: number }
  /**
   * For a page the sidebar does not list: the address of the page it belongs to (each of the six Reports belongs to Reports). It has no row of its own. The sidebar marks the page it
   * belongs to as the current one, and the breadcrumb names this page under that page's group ("Reports › Loans"). The page it belongs to is one that is in the sidebar.
   */
  parent?: string
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    nav?: NavMeta
  }
}
export type NavEntry<To extends string = string> = NavMeta & { to: To }

const DEFAULT_ORDER = 50

/**
 * The pages as this reader finds them, in order, each by the label, the group and the place in it that this reader sees. With `everyone`, the pages that are not this reader's
 * to see are there too: that is for saying where a page is (the breadcrumb), not for what the sidebar shows.
 */
function pagesFor<To extends string>(entries: NavEntry<To>[], role: Role | undefined, everyone: boolean) {
  const admin = role === 'admin'
  return entries
    .filter((entry) => everyone || !entry.adminOnly || admin)
    .map((entry) => ({ ...entry, ...(admin ? undefined : entry.member), label: admin && entry.adminLabel ? entry.adminLabel : entry.label }))
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || a.label.localeCompare(b.label))
}

/** The links this reader sees, in order, each by the label this reader sees it by: the pages with a row in the sidebar, and not those that belong to one of them (`parent`). */
export const navFor = <To extends string>(entries: NavEntry<To>[], role: Role | undefined) => pagesFor(entries, role, false).filter((page) => !page.parent)

/** What the sidebar shows: a link on its own, or a group of links under a label. */
export type NavSection<To extends string = string> =
  | { kind: 'link'; id: string; label: string; to: To }
  | { kind: 'group'; id: NavGroupId; label: string; items: { to: To; label: string }[] }

function sectionsOf<To extends string>(allPages: ReturnType<typeof pagesFor<To>>, role: Role | undefined, everyone: boolean): NavSection<To>[] {
  const pages = allPages.filter((page) => !page.parent) // a page that belongs to another has no row of its own
  const links = pages.filter((page) => !page.group).map((page): NavSection<To> => ({ kind: 'link', id: page.to, label: page.label, to: page.to }))
  const groups = NAV_GROUPS.filter((group) => everyone || !group.adminOnly || role === 'admin').flatMap((group): NavSection<To>[] => {
    const items = pages.filter((page) => page.group === group.id).map(({ to, label }) => ({ to, label }))
    return items.length > 0 ? [{ kind: 'group', id: group.id, label: group.label, items }] : []
  })
  return [...links, ...groups]
}

/** The sidebar for this reader: links of their own first, then each group that has something to show them, in `NAV_GROUPS` order. */
export const navSections = <To extends string>(entries: NavEntry<To>[], role: Role | undefined) => sectionsOf(pagesFor(entries, role, false), role, false)

// "/" is the Summary only; "/transactions" is also the page of a Transaction ("/transactions/42") but not "/transactions-old".
const covers = (to: string, pathname: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`))

/**
 * Where a page is, for the breadcrumb and for which group opens: the group (none for a link on its own) and the page, from the longest address that covers `pathname`. It
 * looks through every page, not only those in this reader's sidebar, so a Member who arrives at Budgets from the Summary is told it is in Set up, though their sidebar has no such group.
 * A page that belongs to another (`parent`) is named as itself, in its parent's group, and `to` is its parent's, because that is the row the sidebar marks; `parent` says so, for
 * the breadcrumb to link its group to that page.
 */
export function trailFor<To extends string>(
  entries: NavEntry<To>[],
  role: Role | undefined,
  pathname: string,
): { group?: string; groupId?: NavGroupId; page?: string; to?: string; parent?: string } {
  const pages = pagesFor(entries, role, true)
  // The sidebar's pages: where each is, which is its group, if it has one.
  const placeOf = new Map<string, { group?: string; groupId?: NavGroupId; to: string }>()
  for (const section of sectionsOf(pages, role, true)) {
    if (section.kind === 'link') placeOf.set(section.to, { to: section.to })
    else for (const { to } of section.items) placeOf.set(to, { group: section.label, groupId: section.id, to })
  }
  // The page whose address is the longest that covers `pathname` is the one it is; it is where its parent is, if it has one, and where it is itself if it does not.
  let best: (typeof pages)[number] | undefined
  for (const page of pages) {
    if (placeOf.has(page.parent ?? page.to) && covers(page.to, pathname) && (!best || page.to.length > best.to.length)) best = page
  }
  if (!best) return {}
  return { ...placeOf.get(best.parent ?? best.to)!, page: best.label, ...(best.parent === undefined ? undefined : { parent: best.parent }) }
}
