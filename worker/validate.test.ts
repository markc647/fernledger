import { describe, expect, it } from 'vitest'
import { CHANGED_MEANWHILE, pathId } from './validate'

// A change that finds its reads went stale answers 409 with this, and the person is told to try again, not to reload: every request reads afresh.
describe('CHANGED_MEANWHILE', () => {
  it('says to try again, names no value, and has a reason a page can tell from other 409s', () => {
    expect(CHANGED_MEANWHILE.error).toMatch(/Try again\.$/)
    expect(CHANGED_MEANWHILE.error).not.toMatch(/reload/i)
    expect(CHANGED_MEANWHILE.reason).toBe('changed')
  })
})

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
