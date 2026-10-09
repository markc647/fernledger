import { describe, expect, it } from 'vitest'
import { carryOutcome, carryStatementsAfterInsert, planCarryOver, type CarryCounts } from './carry-over'

// The decisions about carrying over that need no database: what a chunk does, and what it reports.
const nothing: CarryCounts = { carried: 0, waiting: 0, applied: 0 }

describe('planCarryOver', () => {
  it('does nothing at all for an ordinary chunk with nothing held, so an ordinary Import costs no more', () => {
    expect(planCarryOver({ replacing: false, lastChunk: false }, nothing)).toEqual({ holds: false, applies: false, clears: false, involved: false })
    expect(planCarryOver({ replacing: false, lastChunk: true }, nothing)).toEqual({ holds: false, applies: false, clears: false, involved: false })
  })

  it('holds, gives out and counts in a replace even when the count found nothing, so what it holds is never dropped unreported', () => {
    expect(planCarryOver({ replacing: true, lastChunk: false }, nothing)).toEqual({ holds: true, applies: true, clears: false, involved: true })
  })

  it('clears on the last chunk of a replace, and only there', () => {
    expect(planCarryOver({ replacing: true, lastChunk: true }, nothing).clears).toBe(true)
    expect(planCarryOver({ replacing: true, lastChunk: false }, { carried: 1, waiting: 4, applied: 0 }).clears).toBe(false)
  })

  it('gives out what an earlier replace left held, and clears it on the last chunk', () => {
    expect(planCarryOver({ replacing: false, lastChunk: false }, { ...nothing, waiting: 2 })).toEqual({ holds: false, applies: true, clears: false, involved: true })
    expect(planCarryOver({ replacing: false, lastChunk: true }, { ...nothing, waiting: 2 })).toEqual({ holds: false, applies: true, clears: true, involved: true })
  })

  it('clears the last chunk of an Import that finishes a replace whose waiting rows were all given out already', () => {
    const plan = planCarryOver({ replacing: false, lastChunk: true }, { ...nothing, applied: 3 })
    expect(plan).toEqual({ holds: false, applies: false, clears: true, involved: true })
  })
})

describe('carryOutcome', () => {
  const plan = planCarryOver({ replacing: true, lastChunk: true }, nothing)

  it('is null for a chunk that took no part', () => {
    expect(carryOutcome(planCarryOver({ replacing: false, lastChunk: true }, nothing), nothing, true)).toBeNull()
  })

  it('reports only what a chunk carried when more chunks follow', () => {
    expect(carryOutcome(plan, { carried: 2, waiting: 5, applied: 0 }, false)).toEqual({ carried: 2, carriedTotal: null, lost: null })
  })

  it('reports on the last chunk the total over every chunk, and what was waiting that it did not claim', () => {
    expect(carryOutcome(plan, { carried: 2, waiting: 5, applied: 4 }, true)).toEqual({ carried: 2, carriedTotal: 6, lost: 3 })
  })
})

describe('carryStatementsAfterInsert', () => {
  const prepare = { apply: () => 'apply', markApplied: () => 'mark', clear: () => 'clear' }

  it('gives out, marks what was given, then clears', () => {
    expect(carryStatementsAfterInsert({ holds: true, applies: true, clears: true, involved: true }, prepare)).toEqual(['apply', 'mark', 'clear'])
  })

  it('is empty for a chunk that took no part', () => {
    expect(carryStatementsAfterInsert({ holds: false, applies: false, clears: false, involved: false }, prepare)).toEqual([])
  })

  it('only clears when everything held was given out before', () => {
    expect(carryStatementsAfterInsert({ holds: false, applies: false, clears: true, involved: true }, prepare)).toEqual(['clear'])
  })
})
