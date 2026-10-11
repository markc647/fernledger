import { describe, expect, it } from 'vitest'
import type { BankCsvRow } from './bank-csv'
import { CHUNK_SIZE, countOnOrAfter, DAILY_ROW_WRITES, MAX_CHUNKS, MAX_IMPORT_ROWS, planChunks, previewChunks, replaceWrites } from './import-chunks'

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
  it('costs 4 writes for each row removed and each row imported', () => {
    expect(replaceWrites(0, 0)).toBe(0)
    expect(replaceWrites(2000, 1000)).toBe(12_000)
  })

  it('goes over the free plan’s daily allowance beyond about 25,000 rows removed and imported in all', () => {
    expect(replaceWrites(15_000, 10_000)).toBeLessThanOrEqual(DAILY_ROW_WRITES)
    expect(replaceWrites(16_000, 10_000)).toBeGreaterThan(DAILY_ROW_WRITES)
  })

  it('adds 10 writes for each Override, Note or Not a Transfer mark to carry over, at most, on top of the 4 for each row removed and imported', () => {
    expect(replaceWrites(2000, 1000, 40)).toBe(12_000 + 10 * 40)
    expect(replaceWrites(15_000, 10_000, 1000)).toBeGreaterThan(DAILY_ROW_WRITES)
  })

  it('adds 7 writes for each Transfer: 3 when it is removed (its Transfer index entry and its matching Transaction let go), 4 to write both halves when it comes back', () => {
    expect(replaceWrites(2000, 1000, 0, 100)).toBe(12_000 + 700)
    // Every row a Transfer: a row costs 7 to remove and 8 to import, so about 6,600 each way fill the day.
    expect(replaceWrites(6600, 6600, 0, 6600)).toBeLessThanOrEqual(DAILY_ROW_WRITES)
    expect(replaceWrites(6700, 6700, 0, 6700)).toBeGreaterThan(DAILY_ROW_WRITES)
  })
})

describe('previewChunks', () => {
  it('sends only the bank’s unique ID and the amount, each ID once, oldest first', () => {
    const rows = [row('2026-09-02', 'B'), row('2026-09-01', 'A'), row('2026-09-02', 'B')]
    expect(previewChunks(rows, null)).toEqual([
      [
        { uniqueId: 'A', amountCents: -100 },
        { uniqueId: 'B', amountCents: -100 },
      ],
    ])
  })

  it('leaves out the rows on or after the Cutover Date, which are not imported', () => {
    const rows = [row('2026-09-30', 'A'), row('2026-10-01', 'B'), row('2026-10-02', 'C')]
    expect(previewChunks(rows, '2026-10-01').flat().map((r) => r.uniqueId)).toEqual(['A'])
  })

  it('splits into chunks of the size the Worker takes, and sends none for no rows', () => {
    expect(previewChunks(many(CHUNK_SIZE * 2 + 1), null).map((chunk) => chunk.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 1])
    expect(previewChunks([], null)).toEqual([])
  })
})
