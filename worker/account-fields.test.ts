import { describe, expect, it } from 'vitest'
import { isGeneratedKey, normaliseAccountNumber } from './account-fields'

describe('normaliseAccountNumber', () => {
  it.each([
    ['99-9999-9999999-99', '99-9999-9999999-99'],
    ['99-9999-9999999-099', '99-9999-9999999-99'],
    ['99-9999-9999999-000', '99-9999-9999999-00'],
    ['99-9999-9999999-100', '99-9999-9999999-100'],
    ['99-9999-9999999-009', '99-9999-9999999-09'],
    // A generated key has no suffix to lose: it is `card-` and at least four digits, which `-0dd` at the end cannot match.
    ['card-0001', 'card-0001'],
    ['card-0010', 'card-0010'],
  ])('%s becomes %s', (given, expected) => {
    expect(normaliseAccountNumber(given)).toBe(expected)
  })
})

describe('isGeneratedKey', () => {
  it('knows a key Fernledger generated from a number the bank printed', () => {
    expect(isGeneratedKey('card-0001')).toBe(true)
    expect(isGeneratedKey('card-10000')).toBe(true)
    expect(isGeneratedKey('99-9999-9999999-99')).toBe(false)
    expect(isGeneratedKey('card-1')).toBe(false)
  })
})
