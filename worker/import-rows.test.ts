import { describe, expect, it } from 'vitest'
import { badRowField, serialiseRows } from './import-rows'

const row = { date: '2026-10-01', uniqueId: 'ID1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -100 }

describe('serialiseRows', () => {
  it('keeps only the known fields of each row, so an oversized extra field never reaches the database', () => {
    const json = serialiseRows([{ ...row, junk: 'x'.repeat(10_000) } as typeof row])

    expect(JSON.parse(json)).toEqual([row])
    expect(json.length).toBeLessThan(1000)
  })
})

describe('badRowField', () => {
  it('accepts a good row', () => {
    expect(badRowField([row])).toBeNull()
  })
})
