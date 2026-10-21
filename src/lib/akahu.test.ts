import { describe, expect, it } from 'vitest'
import { akahuWords } from './akahu'

describe('akahuWords (Akahu\'s status and type, as words)', () => {
  it.each([
    ['ACTIVE', 'Active'],
    ['CHECKING', 'Checking'],
    ['CREDIT_CARD', 'Credit card'],
    ['KIWISAVER', 'Kiwisaver'],
    ['', ''],
  ])('reads %s as %s', (word, words) => {
    expect(akahuWords(word)).toBe(words)
  })
})
