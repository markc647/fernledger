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
})
