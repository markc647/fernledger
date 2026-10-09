import { describe, expect, it } from 'vitest'
import { chunkDetail, chunkStatements, chunkSummary, replaceWouldLeaveNothing, type ChunkOutcome } from './import-chunk'

const outcome: ChunkOutcome = { accountName: 'Savings', replace: false, removed: 0, added: 3, dropped: 0, index: 0, count: 1 }

describe('chunkSummary', () => {
  it('says how many rows an Import added', () => {
    expect(chunkSummary(outcome)).toBe('Imported 3 rows into Savings')
  })

  it('names the part of a file sent in several, and the rows skipped for the Cutover Date', () => {
    expect(chunkSummary({ ...outcome, index: 1, count: 4, dropped: 2 })).toBe('Imported 3 rows into Savings, skipped 2 dated on or after the Cutover Date (part 2 of 4)')
  })

  it('says how many rows a replace removed and imported', () => {
    expect(chunkSummary({ ...outcome, replace: true, removed: 7 })).toBe('Replaced imported history in Savings: removed 7 rows, imported 3 rows')
  })
})

describe('chunkDetail', () => {
  it('records what the chunk did and what the file was, counting duplicates as the rows neither added nor dropped', () => {
    const file = { adapterId: 'asb', rowCount: 10, skipped: 1, from: '2026-09-01', to: '2026-10-01', ledgerBalance: { cents: 12_345, date: '2026-10-01' } }
    expect(chunkDetail({ ...outcome, index: 1, count: 2, dropped: 1 }, { file, rowsInChunk: 6, cutoverDate: '2026-10-01', newAccount: false })).toEqual({
      adapter: 'asb',
      part: 2,
      parts: 2,
      added: 3,
      duplicates: 2,
      dropped: 1,
      cutoverDate: '2026-10-01',
      replaced: false,
      removed: 0,
      fileRows: 10,
      skipped: 1,
      from: '2026-09-01',
      to: '2026-10-01',
      ledgerBalance: { cents: 12_345, date: '2026-10-01' },
      newAccount: false,
    })
  })
})

describe('chunkStatements', () => {
  const prepare = { createAccount: () => 'create', setCutover: () => 'cutover', clearBalances: () => 'balances', removeImported: () => 'remove', insertRows: () => 'insert' }
  const plan = { newAccount: false, setsCutover: false, replace: false }

  it('only inserts for a plain chunk of an existing Account', () => {
    expect(chunkStatements(plan, prepare)).toEqual(['insert'])
  })

  it('creates a new Account first, and never also sets its Cutover Date or removes anything', () => {
    expect(chunkStatements({ newAccount: true, setsCutover: true, replace: true }, prepare)).toEqual(['create', 'insert'])
  })

  it('sets the Cutover Date, then removes the old balances and rows, then inserts, so the insert is last and the removal just before it', () => {
    expect(chunkStatements({ ...plan, setsCutover: true, replace: true }, prepare)).toEqual(['cutover', 'balances', 'remove', 'insert'])
  })
})

describe('replaceWouldLeaveNothing', () => {
  const replacing = { replace: true, removed: 5, dropped: 3, rowsInChunk: 3 }

  it('is true when old rows would go and every row of the chunk is dropped', () => {
    expect(replaceWouldLeaveNothing(replacing)).toBe(true)
  })

  it('is false when any row would be kept, when nothing would be removed, or when not replacing', () => {
    expect(replaceWouldLeaveNothing({ ...replacing, dropped: 2 })).toBe(false)
    expect(replaceWouldLeaveNothing({ ...replacing, removed: 0 })).toBe(false)
    expect(replaceWouldLeaveNothing({ ...replacing, replace: false })).toBe(false)
  })
})
