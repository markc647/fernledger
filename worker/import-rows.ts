import { isRealDate } from './dates'

/** One Transaction row from a bank CSV, as the browser sends it. The browser's `BankCsvRow` (src/lib/bank-csv/types.ts) is this type. Dates are ISO `YYYY-MM-DD` NZ dates; money is integer NZD cents. */
export type ImportRow = {
  date: string
  /** The bank's own unique ID for the row. */
  uniqueId: string
  tranType: string
  chequeNumber: string | null
  payee: string
  bankMemo: string
  amountCents: number
}

export const MAX_ROWS_PER_CHUNK = 500

/** D1 Free allows this many rows written a day (ADR 0004). Once it is used up, every write fails until the next day. */
export const DAILY_ROW_WRITES = 100_000

/**
 * A row costs 3 writes: the row itself, its date index and its unique-ID index. Removing a row costs the same.
 * An imported row that a Rule matches costs one or two more (rule-apply.ts stores the result on its row, and a Rule's Category
 * also has an entry in the rule_category index, which removing the row takes out again); the estimates built on this number leave
 * that out, and the day's limit is still handled when it is reached.
 */
export const WRITES_PER_ROW = 3

/** Chunks in one Import, so 10,000 rows: at most 30,000 of the day's writes. */
export const MAX_CHUNKS = 20

/**
 * Most Import-sourced rows removed in one go when replacing imported history: 15,000 writes, leaving room in the day
 * for the new file (at most 10,000 rows, 30,000 writes). Larger histories are removed in steps of this size first
 * (`/api/imports/clear-history`). A replace writes about 3 x (rows removed + rows imported) in all, so the day's
 * allowance covers roughly 33,000 rows between them. An Account with more imported rows than that cannot be
 * replaced in one day: the Import stops at the limit ("Daily limit reached") and the Admin carries on the next day.
 */
export const REPLACE_SLICE = 5000

const isText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max

/**
 * Checks a chunk's rows and returns the path of the first bad field (`rows.3.date`), or null if all are fine.
 * Written by hand rather than as a zod schema on purpose: a free-plan invocation has 10 ms of CPU (ADR 0004), and
 * measured in Node, zod's per-row checks took 4-12 ms for 500 rows while this takes about 1 ms.
 * It never returns a value, only a path, so Transaction data can't reach an error message.
 */
export function badRowField(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CHUNK) return 'rows'
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown> | null
    if (typeof row !== 'object' || row === null) return `rows.${i}`
    if (!isRealDate(row.date)) return `rows.${i}.date`
    if (typeof row.uniqueId !== 'string' || row.uniqueId.length < 1 || row.uniqueId.length > 64) return `rows.${i}.uniqueId`
    if (!isText(row.tranType, 40)) return `rows.${i}.tranType`
    if (row.chequeNumber !== null && !isText(row.chequeNumber, 40)) return `rows.${i}.chequeNumber`
    if (!isText(row.payee, 200)) return `rows.${i}.payee`
    if (!isText(row.bankMemo, 200)) return `rows.${i}.bankMemo`
    if (!Number.isSafeInteger(row.amountCents)) return `rows.${i}.amountCents`
  }
  return null
}

/** The chunk's rows as JSON for the database, with only the known fields: anything extra a client sent is dropped. */
export const serialiseRows = (rows: readonly ImportRow[]) =>
  JSON.stringify(
    rows.map(({ date, uniqueId, tranType, chequeNumber, payee, bankMemo, amountCents }) => ({ date, uniqueId, tranType, chequeNumber, payee, bankMemo, amountCents })),
  )
