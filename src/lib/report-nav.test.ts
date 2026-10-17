import { describe, expect, it } from 'vitest'
import { navSections, trailFor, type NavEntry } from './nav'
import { reportNav } from './report-nav'
import { REPORTS } from './reports'

// Each of the six Reports declares its place with `reportNav` (src/routes/reports_.*.tsx), as the routes do: the Reports page, and the Reports with the address of each.
const entries: NavEntry[] = [
  { to: '/reports', label: 'Reports', group: 'reports', order: 10 },
  ...Object.values(REPORTS).map((report) => ({ to: report.to, ...reportNav(report) })),
]

describe('a Report in the navigation', () => {
  it('has a row of its own in the Admin\'s sidebar under Reports, after the Reports page and in the order the Reports page keeps them', () => {
    const reports = navSections(entries, 'admin').find((section) => section.kind === 'group' && section.id === 'reports')
    expect(reports?.kind === 'group' && reports.items.map((item) => item.label)).toEqual(['Reports', ...Object.values(REPORTS).map((report) => report.name)])
  })

  it('is not in a Member\'s sidebar, or a stranger\'s, who make none; they have the Reports page', () => {
    for (const role of ['member', undefined] as const) {
      const reports = navSections(entries, role).find((section) => section.kind === 'group' && section.id === 'reports')
      expect(reports?.kind === 'group' && reports.items.map((item) => item.label)).toEqual(['Reports'])
    }
  })

  it('is marked itself for the Admin, with Reports linked back from the breadcrumb, and is a page of Reports for a Member', () => {
    expect(trailFor(entries, 'admin', '/reports/loans')).toEqual({ group: 'Reports', groupId: 'reports', page: 'Loans', to: '/reports/loans', parent: '/reports' })
    expect(trailFor(entries, 'member', '/reports/loans')).toEqual({ group: 'Reports', groupId: 'reports', page: 'Loans', to: '/reports', parent: '/reports' })
  })

  it('leaves room in the order between Reports, so another page can be put among them', () => {
    const orders = Object.values(REPORTS).map((report) => reportNav(report).order!)
    expect(orders).toEqual([20, 30, 40, 50, 60, 70])
  })
})
