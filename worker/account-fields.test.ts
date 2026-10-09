import { describe, expect, it } from 'vitest'
import { normaliseAccountNumber } from './account-fields'

describe('normaliseAccountNumber', () => {
  it.each([
    ['99-9999-9999999-99', '99-9999-9999999-99'],
    ['99-9999-9999999-099', '99-9999-9999999-99'],
    ['99-9999-9999999-000', '99-9999-9999999-00'],
    ['99-9999-9999999-100', '99-9999-9999999-100'],
    ['99-9999-9999999-009', '99-9999-9999999-09'],
  ])('%s becomes %s', (given, expected) => {
    expect(normaliseAccountNumber(given)).toBe(expected)
  })
})
