import { describe, expect, it } from 'vitest'
import { pathId } from './validate'

// pathId reads an ID from a path: digits only, from 1, at most 15 digits. Anything else is null, and the route answers 404.
describe('pathId', () => {
  it.each([
    ['1', 1],
    ['10', 10],
    ['999999999999999', 999999999999999],
  ])('reads %j as %j', (raw, id) => {
    expect(pathId(raw)).toBe(id)
  })

  it.each([
    '0',
    '00',
    '-10',
    '',
    ' ',
    '\t',
    '10\n',
    '１０', // fullwidth 10
    '١٠', // Arabic-Indic 10
    '1234567890123456', // 16 digits
  ])('refuses %j', (raw) => {
    expect(pathId(raw)).toBeNull()
  })
})
