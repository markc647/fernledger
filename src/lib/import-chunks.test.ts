import { describe, expect, it } from 'vitest'
import type { BankCsvRow } from './bank-csv'
import { CHUNK_SIZE, planChunks } from './import-chunks'

const row = (date: string, uniqueId: string): BankCsvRow => ({ date, uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE', bankMemo: '', amountCents: -100 })
const many = (n: number) => Array.from({ length: n }, (_, i) => row('2026-10-01', `ID${String(i).padStart(5, '0')}`))

describe('planChunks', () => {
  it('splits rows into chunks of 500', () => {
    expect(CHUNK_SIZE).toBe(500)
    expect(planChunks(many(1200)).map((chunk) => chunk.length)).toEqual([500, 500, 200])
    expect(planChunks(many(500)).map((chunk) => chunk.length)).toEqual([500])
    expect(planChunks(many(501)).map((chunk) => chunk.length)).toEqual([500, 1])
  })

  it('sends no chunks for no rows', () => {
    expect(planChunks([])).toEqual([])
  })

  it('sends the oldest rows first, in the bank order within a day, whatever order the file was in', () => {
    const newestFirst = [row('2019-10-31', '2019103101'), row('2019-10-04', '2019100402'), row('2019-10-04', '2019100401'), row('2019-10-02', '2019100201')]

    expect(planChunks(newestFirst).flat().map((r) => r.uniqueId)).toEqual(['2019100201', '2019100401', '2019100402', '2019103101'])
  })
})
