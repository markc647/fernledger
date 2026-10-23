import { describe, expect, it } from 'vitest'
import { isGeneratedKey } from './account-key'

describe('isGeneratedKey', () => {
  it('knows a key Fernledger generated', () => {
    expect(isGeneratedKey('card-0001')).toBe(true)
    expect(isGeneratedKey('card-0042')).toBe(true)
    expect(isGeneratedKey('card-10000')).toBe(true)
  })

  it('knows a number the bank printed', () => {
    expect(isGeneratedKey('99-9999-9999999-99')).toBe(false)
    expect(isGeneratedKey('99-9999-9999999-099')).toBe(false)
  })

  it('is not fooled by something shaped like neither', () => {
    expect(isGeneratedKey('card-1')).toBe(false)
    expect(isGeneratedKey('card-')).toBe(false)
    expect(isGeneratedKey('Visa')).toBe(false)
    expect(isGeneratedKey('')).toBe(false)
  })
})
