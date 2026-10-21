import { describe, expect, it } from 'vitest'
import { eftposTime, isKiwibank } from './kiwibank-time'

describe('eftposTime', () => {
  it.each([
    ['POS W/D Example Store-12:07', '12:07'],
    ['POS W/D Example Store-17:35', '17:35'],
    ['POS W/D Example Store-00:00', '00:00'],
    ['POS W/D Example Store-23:59', '23:59'],
    ['POS W/D Example Store-09:05  ', '09:05'], // trailing spaces are not text after the time
    ['-12:07', '12:07'],
  ])('reads the time at the end of %j', (description, time) => {
    expect(eftposTime(description)).toBe(time)
  })

  it.each([
    ['a description with no time', 'DIRECT DEBIT Example Energy'],
    ['an empty description', ''],
    ['an hour past 23', 'POS W/D Example Store-24:00'],
    ['minutes past 59', 'POS W/D Example Store-12:60'],
    ['both out of range', 'POS W/D Example Store-25:99'],
    ['no colon', 'POS W/D Example Store-1207'],
    ['no dash', 'POS W/D Example Store 12:07'],
    ['a one-digit hour', 'POS W/D Example Store-9:05'],
    ['a time in the middle', 'POS W/D Example-12:07 Store'],
    ['a longer number run', 'POS W/D Example Store-112:07'],
    ['seconds as well', 'POS W/D Example Store-12:07:30'],
    ['an account-like suffix', 'Example 99-9999-9999999-00'],
  ])('reads no time from %s', (_, description) => {
    expect(eftposTime(description)).toBeNull()
  })
})

describe('isKiwibank', () => {
  it('is true for the connection Akahu calls Kiwibank, whatever the case', () => {
    expect(isKiwibank('Kiwibank')).toBe(true)
    expect(isKiwibank(' kiwibank ')).toBe(true)
  })

  it('is false for another bank, and for a connection not known', () => {
    expect(isKiwibank('ASB')).toBe(false)
    expect(isKiwibank('Kiwibank Business')).toBe(false)
    expect(isKiwibank(null)).toBe(false)
    expect(isKiwibank(undefined)).toBe(false)
  })
})
