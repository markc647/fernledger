import { describe, expect, it } from 'vitest'
import { navFor, navSections, NAV_GROUPS, trailFor, type NavEntry } from './nav'

const entries = [
  { to: '/settings', label: 'Settings', adminOnly: true, order: 90 },
  { to: '/accounts', label: 'Accounts' },
  { to: '/', label: 'Summary', order: 0 },
]

describe('navFor', () => {
  it('shows the Admin everything, by order and then alphabetically', () => {
    expect(navFor(entries, 'admin').map((e) => e.label)).toEqual(['Summary', 'Accounts', 'Settings'])
  })

  it('hides Admin-only items from a Member', () => {
    expect(navFor(entries, 'member').map((e) => e.label)).toEqual(['Summary', 'Accounts'])
  })

  it('hides Admin-only items when not signed in', () => {
    expect(navFor(entries, undefined).map((e) => e.label)).toEqual(['Summary', 'Accounts'])
  })

  describe('a link the Admin knows by another name', () => {
    const withDashboard = [{ to: '/', label: 'Summary', adminLabel: 'Dashboard', order: 0 }, ...entries.filter((e) => e.to !== '/')]

    it('calls it by the Admin\'s label for the Admin, and by its own for a Member or a stranger', () => {
      expect(navFor(withDashboard, 'admin').map((e) => e.label)).toEqual(['Dashboard', 'Accounts', 'Settings'])
      expect(navFor(withDashboard, 'member').map((e) => e.label)).toEqual(['Summary', 'Accounts'])
      expect(navFor(withDashboard, undefined).map((e) => e.label)).toEqual(['Summary', 'Accounts'])
    })

    it('keeps its address, and sorts by the label the reader sees', () => {
      expect(navFor(withDashboard, 'admin')[0]).toMatchObject({ to: '/', label: 'Dashboard' })
      const tied = [{ to: '/a', label: 'Zebra', adminLabel: 'Apple', order: 1 }, { to: '/b', label: 'Mango', order: 1 }]
      expect(navFor(tied, 'admin').map((e) => e.label)).toEqual(['Apple', 'Mango'])
      expect(navFor(tied, 'member').map((e) => e.label)).toEqual(['Mango', 'Zebra'])
    })
  })

  describe('a page a Member finds somewhere else', () => {
    const moved = [{ to: '/accounts', label: 'Accounts', group: 'setup', order: 30, member: { group: 'reports', order: 60 } }, { to: '/reports', label: 'Reports', group: 'reports', order: 50 }] as const

    it('is in its own group and place for the Admin, and in the Member\'s for a Member or a stranger', () => {
      expect(navFor([...moved], 'admin').map((e) => [e.label, e.group])).toEqual([['Accounts', 'setup'], ['Reports', 'reports']])
      expect(navFor([...moved], 'member').map((e) => [e.label, e.group])).toEqual([['Reports', 'reports'], ['Accounts', 'reports']])
      expect(navFor([...moved], undefined).map((e) => [e.label, e.group])).toEqual([['Reports', 'reports'], ['Accounts', 'reports']])
    })
  })
})

// The sidebar's entries, as the routes declare them (src/routes/*.tsx `staticData.nav`).
const routes: NavEntry[] = [
  { to: '/', label: 'Summary', adminLabel: 'Dashboard', order: 0 },
  { to: '/transactions', label: 'All Transactions', group: 'transactions', order: 10 },
  { to: '/uncategorised', label: 'Uncategorised', group: 'transactions', adminOnly: true, order: 15 },
  { to: '/import', label: 'Import', group: 'transactions', adminOnly: true, order: 20 },
  { to: '/reports', label: 'Reports', group: 'reports', order: 50 },
  { to: '/accounts', label: 'Accounts', group: 'setup', order: 30, member: { group: 'reports', order: 60 } },
  { to: '/categories', label: 'Categories', group: 'setup', order: 40 },
  { to: '/rules', label: 'Rules', group: 'setup', adminOnly: true, order: 45 },
  { to: '/budgets', label: 'Budgets', group: 'setup', order: 46 },
  { to: '/settings', label: 'Settings', group: 'setup', adminOnly: true, order: 90 },
  { to: '/change-log', label: 'Change Log', group: 'help', order: 80 },
  { to: '/about-your-data', label: 'About your data', group: 'help', order: 85 },
  { to: '/how-to-sign-in', label: 'How to sign in', group: 'help', order: 86 },
]

/** The sections as the sidebar shows them: a link by its label, or a group by its label and what is in it. */
const outline = (role: Parameters<typeof navSections>[1]) =>
  navSections(routes, role).map((section) => (section.kind === 'link' ? section.label : `${section.label}: ${section.items.map((item) => item.label).join(', ')}`))

describe('navSections', () => {
  it('gives the Admin the Dashboard, then each group in its place, with the pages in each by order', () => {
    expect(outline('admin')).toEqual([
      'Dashboard',
      'Transactions: All Transactions, Uncategorised, Import',
      'Reports: Reports',
      'Set up: Accounts, Categories, Rules, Budgets, Settings',
      'Help: Change Log, About your data, How to sign in',
    ])
  })

  it('gives a Member the Summary and no Set up group at all, with Accounts among the Reports, last', () => {
    expect(outline('member')).toEqual([
      'Summary',
      'Transactions: All Transactions',
      'Reports: Reports, Accounts',
      'Help: Change Log, About your data, How to sign in',
    ])
  })

  it('leaves Categories and Budgets out of a Member\'s sidebar: only Accounts has a place for them', () => {
    const labels = navSections(routes, 'member').flatMap((section) => (section.kind === 'link' ? [section.label] : section.items.map((item) => item.label)))
    expect(labels).not.toContain('Categories')
    expect(labels).not.toContain('Budgets')
    expect(labels).toContain('Accounts')
  })

  it('treats a stranger (who is signed in is not known) as a Member', () => {
    expect(outline(undefined)).toEqual(outline('member'))
  })

  it('drops a group with nothing left in it', () => {
    const onlyAdminPages = routes.filter((entry) => entry.group !== 'transactions' || entry.adminOnly)
    expect(navSections(onlyAdminPages, 'member').map((section) => section.label)).not.toContain('Transactions')
    expect(navSections(onlyAdminPages, 'admin').map((section) => section.label)).toContain('Transactions')
  })

  it('keeps a link that is in no group at the top, whatever its order', () => {
    const late = [...routes, { to: '/late', label: 'Late', order: 99 }]
    expect(navSections(late, 'admin').map((section) => section.label).slice(0, 2)).toEqual(['Dashboard', 'Late'])
  })

  it('hides the Set up group from a Member because the group says so, not because of the pages in it', () => {
    expect(NAV_GROUPS.filter((group) => group.adminOnly).map((group) => group.id)).toEqual(['setup'])
    const openToAll = routes.map((entry) => ({ ...entry, adminOnly: false }))
    expect(navSections(openToAll, 'member').map((section) => section.label)).not.toContain('Set up')
    expect(navSections(openToAll, 'admin').map((section) => section.label)).toContain('Set up')
  })

  it('keeps the address of every page, so the sidebar links to the route and not to its label', () => {
    const transactions = navSections(routes, 'admin').find((section) => section.kind === 'group' && section.id === 'transactions')
    expect(transactions?.kind === 'group' && transactions.items.map((item) => item.to)).toEqual(['/transactions', '/uncategorised', '/import'])
  })
})

describe('trailFor', () => {
  it('finds the page and its group', () => {
    expect(trailFor(routes, 'admin', '/import')).toEqual({ group: 'Transactions', groupId: 'transactions', page: 'Import', to: '/import' })
    expect(trailFor(routes, 'admin', '/settings')).toMatchObject({ group: 'Set up', page: 'Settings' })
  })

  it('has no group for a link on its own', () => {
    expect(trailFor(routes, 'admin', '/')).toEqual({ page: 'Dashboard', to: '/' })
  })

  it("finds a page's own pages under it: a Transaction is under All Transactions, a Report under Reports", () => {
    expect(trailFor(routes, 'admin', '/transactions/42')).toMatchObject({ group: 'Transactions', page: 'All Transactions' })
    expect(trailFor(routes, 'admin', '/reports/balances')).toMatchObject({ group: 'Reports', page: 'Reports' })
  })

  it('does not take a page whose address only starts the same way', () => {
    expect(trailFor(routes, 'admin', '/transactions-old')).toEqual({})
    expect(trailFor(routes, 'admin', '/reportsy')).toEqual({})
  })

  it('does not take "/" for every page', () => {
    expect(trailFor(routes, 'admin', '/styleguide')).toEqual({})
  })

  it('uses the label and the place this reader sees', () => {
    expect(trailFor(routes, 'member', '/')).toMatchObject({ page: 'Summary' })
    expect(trailFor(routes, 'member', '/accounts')).toMatchObject({ group: 'Reports', page: 'Accounts' })
    expect(trailFor(routes, 'admin', '/accounts')).toMatchObject({ group: 'Set up', page: 'Accounts' })
  })

  // A Member gets to Budgets from the Summary's Budget vs actual, though their sidebar has no Set up group, so the page still says where it is.
  it('says where a page is that the reader\'s sidebar leaves out', () => {
    expect(trailFor(routes, 'member', '/budgets')).toEqual({ group: 'Set up', groupId: 'setup', page: 'Budgets', to: '/budgets' })
    expect(trailFor(routes, 'member', '/rules')).toMatchObject({ group: 'Set up', page: 'Rules' })
    expect(trailFor(routes, 'member', '/import')).toMatchObject({ group: 'Transactions', page: 'Import' })
    expect(trailFor(routes, undefined, '/settings')).toMatchObject({ group: 'Set up', page: 'Settings' })
  })
})
