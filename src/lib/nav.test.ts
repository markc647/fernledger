import { describe, expect, it } from 'vitest'
import { navFor } from './nav'

describe('navFor', () => {
  it('shows the Admin everything', () => {
    expect(navFor('admin').map((item) => item.label)).toEqual(['Summary', 'Settings'])
  })

  it('hides Admin-only items from a Member', () => {
    expect(navFor('member').map((item) => item.label)).toEqual(['Summary'])
  })

  it('shows a signed-out visitor nothing Admin-only', () => {
    expect(navFor(undefined).map((item) => item.label)).toEqual(['Summary'])
  })
})
