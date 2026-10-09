import { describe, expect, it } from 'vitest'
import { isDailyLimitError } from './d1-errors'

describe('isDailyLimitError', () => {
  it.each([
    'D1_ERROR: Exceeded the daily limit of rows written',
    'Your account has reached its daily quota for rows written',
    'D1 DB exceeded its rows written limit for the day',
  ])('recognises %s', (message) => {
    expect(isDailyLimitError(new Error(message))).toBe(true)
  })

  it.each(['D1_ERROR: UNIQUE constraint failed: transactions.bank_unique_id', 'D1_ERROR: forced', 'Network connection lost'])('does not mistake %s for it', (message) => {
    expect(isDailyLimitError(new Error(message))).toBe(false)
  })

  it('is false for something that is not an Error', () => {
    expect(isDailyLimitError('daily limit exceeded')).toBe(false)
    expect(isDailyLimitError(null)).toBe(false)
  })
})
