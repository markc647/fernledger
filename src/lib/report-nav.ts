import type { NavMeta } from './nav'
import { REPORTS, type ReportInfo } from './reports'

/**
 * A Report's place in the navigation, for its route's `staticData: { nav: reportNav(REPORTS.spending) }`. Only the Admin makes Reports (each time the Admin shows one, it is kept
 * for the Members to open: src/routes/reports.tsx), so each has a row of its own in the Admin's sidebar under Reports, in the order of `REPORTS`, with the Reports page first. A Member
 * has no such row: for them a Report is a page of Reports, which they reach from its list, and the sidebar marks Reports. The breadcrumb's Reports links back in both.
 * (Not in reports.ts, which the Worker's tests read too: the navigation is the browser's.)
 */
export const reportNav = (report: ReportInfo): NavMeta => ({
  label: report.name,
  group: 'reports',
  order: 20 + 10 * Object.values(REPORTS).indexOf(report),
  adminOnly: true,
  within: '/reports',
  member: { parent: '/reports' },
})
