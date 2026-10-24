import { describe, expect, it } from 'vitest'
import { roleFor } from './auth'

describe('roleFor', () => {
  it('gives the Admin role to the Admin email, ignoring case', () => {
    expect(roleFor('admin@example.com', 'Admin@Example.com')).toBe('admin')
  })

  it('gives everyone else the Member role', () => {
    expect(roleFor('sib@example.com', 'admin@example.com')).toBe('member')
  })

  it('gives the Member role when no Admin is set', () => {
    expect(roleFor('sib@example.com', undefined)).toBe('member')
  })
})
