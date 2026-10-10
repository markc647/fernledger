import { describe, expect, it } from 'vitest'
import { carryDetail, carryOutcome, carryStatementsAfterInsert, carrySummary, planCarryOver, type CarryCounts, type CarryOutcome } from './carry-over'

// The decisions about carrying over that need no database: what a chunk does, and what it reports.
const nothing: CarryCounts = { carried: 0, differing: 0, waiting: 0, heldRows: 0, applied: 0, appliedDiffering: 0, lostRows: '[]' }
const notLast = { replacing: false, lastChunk: false, finishesReplace: false }
const plainLast = { replacing: false, lastChunk: true, finishesReplace: false }
const replaceFirst = { replacing: true, lastChunk: false, finishesReplace: false }
const replaceLast = { replacing: false, lastChunk: true, finishesReplace: true }

describe('planCarryOver', () => {
  it('does nothing at all for an ordinary chunk with nothing held, so an ordinary Import costs no more', () => {
    const none = { holds: false, applies: false, clears: false, tidies: false, involved: false }
    expect(planCarryOver(notLast, nothing)).toEqual(none)
    expect(planCarryOver(plainLast, nothing)).toEqual(none)
  })

  it('holds and gives out in a replace even when the count found nothing, so what it holds is never dropped unreported', () => {
    expect(planCarryOver(replaceFirst, nothing)).toEqual({ holds: true, applies: true, clears: false, tidies: false, involved: true })
  })

  it('empties what is held on the last chunk of a replace, and only there', () => {
    const held = { ...nothing, waiting: 2, heldRows: 3 }
    expect(planCarryOver(replaceLast, held)).toMatchObject({ clears: true, tidies: false })
    expect(planCarryOver(replaceFirst, held).clears).toBe(false)
    expect(planCarryOver(plainLast, held).clears).toBe(false)
    expect(planCarryOver(notLast, held).clears).toBe(false)
  })

  it('empties a single-chunk replace, which holds and finishes in one chunk', () => {
    expect(planCarryOver({ replacing: true, lastChunk: true, finishesReplace: true }, nothing)).toMatchObject({ holds: true, applies: true, clears: true })
  })

  it('gives out what a stopped replace left held, in any chunk', () => {
    expect(planCarryOver(notLast, { ...nothing, waiting: 2, heldRows: 2 })).toEqual({ holds: false, applies: true, clears: false, tidies: false, involved: true })
  })

  it('only tidies on the last chunk of an Import that is not a replace, so what still waits is kept', () => {
    const held = { ...nothing, waiting: 2, heldRows: 3 }
    expect(planCarryOver(plainLast, held)).toEqual({ holds: false, applies: true, clears: false, tidies: true, involved: true })
    expect(planCarryOver(notLast, held).tidies).toBe(false)
  })

  it('tidies even when nothing waits, because rows given out or with nothing left to give are still held', () => {
    expect(planCarryOver(plainLast, { waiting: 0, heldRows: 3 })).toEqual({ holds: false, applies: false, clears: false, tidies: true, involved: true })
  })

  it('has nothing to clear on the last chunk of a replace that held and was holding nothing', () => {
    expect(planCarryOver(replaceLast, nothing).clears).toBe(false)
  })
})

describe('carryOutcome', () => {
  const lost = JSON.stringify([{ date: '2026-09-01', amountCents: -1000, description: 'EXAMPLE', category: 'Fuel', note: 'Note' }])
  const replacePlan = planCarryOver(replaceLast, { waiting: 5, heldRows: 5 })
  const plainPlan = planCarryOver(plainLast, { waiting: 5, heldRows: 5 })

  it('is null for a chunk that took no part', () => {
    expect(carryOutcome(planCarryOver(plainLast, nothing), nothing, true)).toBeNull()
  })

  it('reports only what a chunk carried when more chunks follow', () => {
    expect(carryOutcome(planCarryOver(replaceFirst, nothing), { ...nothing, carried: 2, waiting: 5 }, false)).toEqual({
      carried: 2,
      carriedTotal: null,
      differing: null,
      lost: null,
      lostRows: [],
      stillWaiting: null,
    })
  })

  it('reports at the end of a replace the total over every chunk, the ones with another amount, and what was waiting that no chunk claimed, listed', () => {
    const counts = { ...nothing, carried: 2, differing: 1, waiting: 5, applied: 4, appliedDiffering: 2, lostRows: lost }
    expect(carryOutcome(replacePlan, counts, true)).toEqual({
      carried: 2,
      carriedTotal: 6,
      differing: 3,
      lost: 3,
      lostRows: [{ date: '2026-09-01', amountCents: -1000, description: 'EXAMPLE', category: 'Fuel', note: 'Note' }],
      stillWaiting: null,
    })
  })

  it('reports at the end of any other Import what still waits instead, and lists nothing', () => {
    const counts = { ...nothing, carried: 2, waiting: 5, applied: 1, lostRows: lost }
    expect(carryOutcome(plainPlan, counts, true)).toMatchObject({ carried: 2, carriedTotal: 3, lost: null, lostRows: [], stillWaiting: 3 })
  })

  it('takes the carried count it is given, for the response that reports what the batch did', () => {
    const counts = { ...nothing, carried: 2, waiting: 5, applied: 4 }
    expect(carryOutcome(replacePlan, counts, true, 1)).toMatchObject({ carried: 1, carriedTotal: 5, lost: 4 })
  })
})

describe('carrySummary and carryDetail', () => {
  const part: CarryOutcome = { carried: 2, carriedTotal: null, differing: null, lost: null, lostRows: [], stillWaiting: null }
  const end: CarryOutcome = { carried: 1, carriedTotal: 5, differing: 0, lost: 2, lostRows: [], stillWaiting: null }

  it('says nothing for a chunk that took no part, or carried none', () => {
    expect(carrySummary(null, 1)).toBe('')
    expect(carrySummary({ ...part, carried: 0 }, 2)).toBe('')
    expect(carryDetail(null)).toEqual({})
  })

  it('says what a part carried', () => {
    expect(carrySummary(part, 3)).toBe(', Overrides and Notes carried over for 2 Transactions')
    expect(carryDetail(part)).toEqual({ carried: 2 })
  })

  it('says at the end of a replace what was carried in all, lost, and given another amount', () => {
    expect(carrySummary(end, 3)).toBe(', Overrides and Notes carried over for 5 Transactions in all, lost for 2 Transactions')
    expect(carrySummary(end, 1)).toBe(', Overrides and Notes carried over for 5 Transactions, lost for 2 Transactions')
    expect(carrySummary({ ...end, differing: 2 }, 1)).toBe(', Overrides and Notes carried over for 5 Transactions (2 with a different amount), lost for 2 Transactions')
    expect(carrySummary({ ...end, lost: 0 }, 1)).toBe(', Overrides and Notes carried over for 5 Transactions, none lost')
    expect(carrySummary({ ...end, carriedTotal: 0, lost: 0 }, 1)).toBe('')
  })

  it('lists the lost Transactions in the detail', () => {
    const listed = [{ date: '2026-09-01', amountCents: -1000, description: 'EXAMPLE', category: null, note: 'Note' }]
    expect(carryDetail({ ...end, lostRows: listed })).toEqual({ carried: 1, carriedTotal: 5, differingAmount: 0, lost: 2, lostTransactions: listed })
  })

  it('says at the end of any other Import how many still wait', () => {
    const waiting: CarryOutcome = { carried: 1, carriedTotal: 3, differing: 0, lost: null, lostRows: [], stillWaiting: 4 }
    expect(carrySummary(waiting, 2)).toBe(', Overrides and Notes carried over for 3 Transactions in all, 4 still waiting')
    expect(carryDetail(waiting)).toEqual({ carried: 1, carriedTotal: 3, differingAmount: 0, stillWaiting: 4 })
    expect(carrySummary({ ...waiting, carriedTotal: 0, stillWaiting: 0 }, 2)).toBe('')
  })
})

describe('carryStatementsAfterInsert', () => {
  const prepare = { apply: () => 'apply', markApplied: () => 'mark', clear: () => 'clear', tidy: () => 'tidy' }

  it('gives out, marks what was given, then clears at the end of a replace', () => {
    expect(carryStatementsAfterInsert({ holds: true, applies: true, clears: true, tidies: false, involved: true }, prepare)).toEqual(['apply', 'mark', 'clear'])
  })

  it('tidies instead at the end of any other Import', () => {
    expect(carryStatementsAfterInsert({ holds: false, applies: true, clears: false, tidies: true, involved: true }, prepare)).toEqual(['apply', 'mark', 'tidy'])
  })

  it('is empty for a chunk that took no part', () => {
    expect(carryStatementsAfterInsert({ holds: false, applies: false, clears: false, tidies: false, involved: false }, prepare)).toEqual([])
  })

  it('only tidies when everything held was given out before', () => {
    expect(carryStatementsAfterInsert({ holds: false, applies: false, clears: false, tidies: true, involved: true }, prepare)).toEqual(['tidy'])
  })
})
