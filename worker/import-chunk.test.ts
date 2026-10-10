import { describe, expect, it } from 'vitest'
import type { CarryOutcome } from './carry-over'
import { chunkDetail, chunkStatements, chunkSummary, replaceWouldLeaveNothing, type ChunkOutcome } from './import-chunk'

/** What a chunk carried, with the fields it did not report left empty. */
const carryOf = (part: Partial<CarryOutcome>): CarryOutcome => ({ carried: 0, carriedTotal: null, differing: null, lost: null, lostRows: [], stillWaiting: null, ...part })

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

  it('says how many Overrides and Notes a replace carried over and lost, before the part it was', () => {
    const carry = carryOf({ carried: 2, carriedTotal: 5, differing: 0, lost: 1 })
    expect(chunkSummary({ ...outcome, replace: true, removed: 7, carry })).toBe('Replaced imported history in Savings: removed 7 rows, imported 3 rows, Overrides and Notes carried over for 5 Transactions, lost for 1 Transaction')
    expect(chunkSummary({ ...outcome, index: 2, count: 3, carry })).toBe('Imported 3 rows into Savings, Overrides and Notes carried over for 5 Transactions in all, lost for 1 Transaction (part 3 of 3)')
  })

  it('says only what a part carried when more parts follow, and nothing when it carried none', () => {
    expect(chunkSummary({ ...outcome, index: 0, count: 2, replace: true, carry: carryOf({ carried: 1 }) })).toBe(
      'Replaced imported history in Savings: removed 0 rows, imported 3 rows, Overrides and Notes carried over for 1 Transaction (part 1 of 2)',
    )
    expect(chunkSummary({ ...outcome, index: 0, count: 2, carry: carryOf({ carried: 0 }) })).toBe('Imported 3 rows into Savings (part 1 of 2)')
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

describe('chunkDetail with carrying over', () => {
  const file = { adapterId: 'asb', rowCount: 10, skipped: 0, from: '2026-09-01', to: '2026-10-01', ledgerBalance: { cents: 0, date: '2026-10-01' } }
  const context = { file, rowsInChunk: 3, cutoverDate: null, newAccount: false }

  it('records what the chunk carried, and on the last part the total and what was lost', () => {
    expect(chunkDetail({ ...outcome, carry: carryOf({ carried: 2, carriedTotal: 5, differing: 1, lost: 1, lostRows: [{ date: '2026-09-01', amountCents: -1, description: 'EXAMPLE', category: null, note: 'Note' }] }) }, context)).toMatchObject({
      carried: 2,
      carriedTotal: 5,
      differingAmount: 1,
      lost: 1,
      lostTransactions: [{ date: '2026-09-01', amountCents: -1, description: 'EXAMPLE', category: null, note: 'Note' }],
    })
    expect(chunkDetail({ ...outcome, carry: carryOf({ carried: 2 }) }, context)).toMatchObject({ carried: 2 })
  })

  it('leaves the fields out for a chunk that took no part', () => {
    expect(Object.keys(chunkDetail(outcome, context))).not.toContain('carried')
    expect(Object.keys(chunkDetail({ ...outcome, carry: carryOf({ carried: 2 }) }, context))).not.toContain('lost')
  })
})

describe('chunkStatements', () => {
  const prepare = {
    createAccount: () => 'create',
    setCutover: () => 'cutover',
    clearBalances: () => 'balances',
    forgetApplied: () => 'forget',
    holdRemoved: () => 'hold',
    unpairPartners: () => 'unpair',
    removeImported: () => 'remove',
    insertRows: () => 'insert',
  }
  const plan = { newAccount: false, setsCutover: false, replace: false }

  it('only inserts for a plain chunk of an existing Account', () => {
    expect(chunkStatements(plan, prepare)).toEqual(['insert'])
  })

  it('creates a new Account first, and never also sets its Cutover Date or removes anything', () => {
    expect(chunkStatements({ newAccount: true, setsCutover: true, replace: true }, prepare)).toEqual(['create', 'insert'])
  })

  it('sets the Cutover Date, then removes the old balances, holds the Overrides and Notes of the rows that go and lets go of their matching Transactions, removes them, then inserts, so the insert is last and the removal just before it', () => {
    expect(chunkStatements({ ...plan, setsCutover: true, replace: true }, prepare)).toEqual(['cutover', 'balances', 'forget', 'hold', 'unpair', 'remove', 'insert'])
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
