import { expect, it } from 'vitest'
import { roleLabel } from './role'

it('names each role the way the screens do', () => {
  expect(roleLabel('admin')).toBe('Admin')
  expect(roleLabel('member')).toBe('Member (read-only)')
})
