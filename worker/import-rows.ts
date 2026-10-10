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
 * A Rule adds to that (rule-apply.ts stores the result on the imported row): 1 for a Transfer mark, 2 for a Category, because
 * the Category also has an entry in the rule_category index; removing a row with a Category takes that entry out, 1 more. So a
 * row removed and its replacement imported cost 6 in all, 9 when a Rule gave them a Category, and carrying an Override or Note
 * over (WRITES_PER_CARRIED) takes that to 16. The estimates built on this number are for the plain 6 and leave the rest out,
 * and the day's limit is still handled when it is reached.
 */
export const WRITES_PER_ROW = 3

/**
 * What carrying one Transaction's Override or Note over costs, at most: holding it (the row and its key, 2), giving it to
 * the new row (the row, and its Category index, 2), marking it given (1) and clearing it (2). A replace of rows that
 * mostly have neither adds little to the 6 per pair above; one where every row has one adds 7 for each pair.
 */
export const WRITES_PER_CARRIED = 7

/** Chunks in one Import, so 10,000 rows: at most 30,000 of the day's writes. */
export const MAX_CHUNKS = 20

/**
 * Most Import-sourced rows removed in one go when replacing imported history: 15,000 writes, leaving room in the day
 * for the new file (at most 10,000 rows, 30,000 writes). Larger histories are removed in steps of this size first
 * (`/api/imports/clear-history`). A slice costs 15,000 writes to remove, up to about 20,000 when a Rule gave every row a
 * Category (4 each, with the rule_category index entry). A replace writes 6 for each row removed and imported, 9 with a Rule's
 * Category and 16 with an Override or Note carried over as well (WRITES_PER_ROW, WRITES_PER_CARRIED), so the day's allowance
 * covers about 16,000 rows replaced at best and about 6,000 at worst. An Account with more imported rows than that cannot be
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

/** What the Replace question sends for each row of the file: the bank's unique ID and the amount, to forecast what would carry over (carry-over.ts). */
export type PreviewRow = { uniqueId: string; amountCents: number }

/**
 * Checks the rows of a forecast request like badRowField checks a chunk's, and for the same reason: a schema is too slow
 * for 500 rows within 10 ms of CPU (ADR 0004). The browser sends the file's rows in requests of at most 500, as it does
 * for an Import; 10,000 rows in one request measured 10 to 17 ms in Node. Returns the path of the first bad field, or null.
 */
export function badPreviewField(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CHUNK) return 'rows'
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown> | null
    if (typeof row !== 'object' || row === null) return `rows.${i}`
    if (typeof row.uniqueId !== 'string' || row.uniqueId.length < 1 || row.uniqueId.length > 64) return `rows.${i}.uniqueId`
    if (!Number.isSafeInteger(row.amountCents)) return `rows.${i}.amountCents`
  }
  return null
}

/** The forecast's rows as JSON for the database, with only the known fields. */
export const serialisePreviewRows = (rows: readonly PreviewRow[]) => JSON.stringify(rows.map(({ uniqueId, amountCents }) => ({ uniqueId, amountCents })))
