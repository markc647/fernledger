import { describe, expect, it } from 'vitest'
import type { BankCsvRow } from './bank-csv'
import { CHUNK_SIZE, countOnOrAfter, DAILY_ROW_WRITES, MAX_CHUNKS, MAX_IMPORT_ROWS, planChunks, replaceWrites } from './import-chunks'

const row = (date: string, uniqueId: string): BankCsvRow => ({ date, uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE', bankMemo: '', amountCents: -100 })
const many = (n: number) => Array.from({ length: n }, (_, i) => row('2026-10-01', `ID${String(i).padStart(5, '0')}`))

describe('planChunks', () => {
  it('splits rows into chunks of CHUNK_SIZE', () => {
    expect(planChunks(many(CHUNK_SIZE * 2 + 200)).map((chunk) => chunk.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 200])
    expect(planChunks(many(CHUNK_SIZE)).map((chunk) => chunk.length)).toEqual([CHUNK_SIZE])
    expect(planChunks(many(CHUNK_SIZE + 1)).map((chunk) => chunk.length)).toEqual([CHUNK_SIZE, 1])
  })

  it('plans no more chunks than the Worker accepts for a file of the most rows an Import can carry', () => {
    expect(planChunks(many(MAX_IMPORT_ROWS))).toHaveLength(MAX_CHUNKS)
    expect(planChunks(many(MAX_IMPORT_ROWS + 1))).toHaveLength(MAX_CHUNKS + 1)
  })

  it('sends no chunks for no rows', () => {
    expect(planChunks([])).toEqual([])
  })

  it('sends the oldest rows first, in the bank order within a day, whatever order the file was in', () => {
    const newestFirst = [row('2019-10-31', '2019103101'), row('2019-10-04', '2019100402'), row('2019-10-04', '2019100401'), row('2019-10-02', '2019100201')]

    expect(planChunks(newestFirst).flat().map((r) => r.uniqueId)).toEqual(['2019100201', '2019100401', '2019100402', '2019103101'])
  })
})

describe('countOnOrAfter', () => {
  const rows = [row('2026-09-30', 'A'), row('2026-10-01', 'B'), row('2026-10-02', 'C')]

  it('counts the rows on the Cutover Date and after it, but not before', () => {
    expect(countOnOrAfter(rows, '2026-10-01')).toBe(2)
    expect(countOnOrAfter(rows, '2026-10-02')).toBe(1)
    expect(countOnOrAfter(rows, '2026-10-03')).toBe(0)
  })

  it('counts nothing when there is no Cutover Date', () => {
    expect(countOnOrAfter(rows, null)).toBe(0)
    expect(countOnOrAfter(rows, undefined)).toBe(0)
  })
})

describe('replaceWrites', () => {
  it('costs 3 writes for each row removed and each row imported', () => {
    expect(replaceWrites(0, 0)).toBe(0)
    expect(replaceWrites(2000, 1000)).toBe(9000)
  })

  it('goes over the free plan’s daily allowance beyond about 33,000 rows removed and imported in all', () => {
    expect(replaceWrites(23_000, 10_000)).toBeLessThanOrEqual(DAILY_ROW_WRITES)
    expect(replaceWrites(24_000, 10_000)).toBeGreaterThan(DAILY_ROW_WRITES)
  })
})
