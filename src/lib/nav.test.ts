import { describe, expect, it } from 'vitest'
import { navFor } from './nav'

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
})
