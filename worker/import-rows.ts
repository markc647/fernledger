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
 * A row costs 4 writes: the row itself and its three indexes (its date, its Account and date, and its unique ID: migrations 0802 and 1002), and an insert
 * statement writes 1 more for the table's row counter, once however many rows it inserts. Pinned in imports.test.ts. Removing a row is taken to cost the same 4,
 * because every index entry goes too; the local database reports a deleted row as 1, so that half is the model and not a measurement.
 * A Rule adds to that (rule-apply.ts stores the result on the imported row): 1 for a Transfer mark, 2 for a Category, because
 * the Category also has an entry in the rule_category index; removing a row with a Category takes that entry out, 1 more. So a
 * row removed and its replacement imported cost 8 in all, 11 when a Rule gave them a Category. A Transfer (WRITES_PER_PAIRED_IMPORTED
 * and _REMOVED) and an Override, Note or Not a Transfer mark carried over (WRITES_PER_CARRIED) cost more again. The estimates built on this number are
 * for the plain 8 and leave the rest out, and the day's limit is still handled when it is reached.
 */
export const WRITES_PER_ROW = 4

/**
 * What carrying one Transaction's Override, Note or Not a Transfer mark over costs, at most: 10. Holding it writes the row and its key (2). Giving it to
 * the new row writes the row, and an entry in the index of the Override's Category and one in the mark's index (3 with both; a Note is in no index). Marking it
 * given writes the row (1), and clearing it deletes the row and its key (2). That is 8 for a row with all three. Removing the row it came from takes its entry out
 * of the Override index and out of the mark index, 1 more each (WRITES_PER_OVERRIDE_REMOVED, WRITES_PER_MARK_REMOVED). So an Override alone costs 8 (7 and its
 * entry in the index), a mark alone 8, a Note alone 6. Pinned in not-a-transfer.test.ts. A replace of rows that mostly have none adds little to the 8 per pair
 * above; one where every row has all three adds 10 for each pair.
 */
export const WRITES_PER_CARRIED = 10

/** Removing a row that has an Override takes its entry out of the Override index (migrations/1101_categories.sql). */
export const WRITES_PER_OVERRIDE_REMOVED = 1

/** Removing a row that has a Not a Transfer mark takes its entry out of the index the mark has (migrations/3702_not_a_transfer_carry_over.sql). */
export const WRITES_PER_MARK_REMOVED = 1

/**
 * What a Transfer costs on top of the 4 per row. Pairing writes the matching Transaction's ID on both halves, each a row and an
 * entry in the Transfer index (transfers.ts), and both halves are written by the Import that adds the second one, so an imported
 * row that is paired costs 4 more: 8 in all. Removing a paired row deletes its own entry in the Transfer index (1) and lets go of its
 * matching Transaction, a row and an index entry (2), so a removed row that was paired costs 3 more: 7 in all. A replace that gives
 * back rows its history had paired removes at 7 and imports at 8: 15 for a row replaced, where an unpaired one costs 8.
 */
export const WRITES_PER_PAIRED_IMPORTED = 4
export const WRITES_PER_PAIRED_REMOVED = 3

/** Chunks in one Import, so 10,000 rows: at most 40,000 of the day's writes, and 20 more for the chunks' insert statements. */
export const MAX_CHUNKS = 20

/**
 * Most Import-sourced rows removed in one go when replacing imported history: 20,000 writes, leaving room in the day
 * for the new file (at most 10,000 rows, 40,000 writes). Larger histories are removed in steps of this size first
 * (`/api/imports/clear-history`). A slice costs 20,000 writes to remove, up to about 25,000 when a Rule gave every row a Category (5 each, with the
 * rule_category index entry), 1 more for each row with an Override and 1 more for each with a mark (2 for a row with both), and 5,000 x 3 = 15,000 more if
 * every row was paired (it lets go of its matching Transaction too: WRITES_PER_PAIRED_REMOVED). A replace writes 8 for each row removed and imported, and
 * 11 when a Rule gave the row a Category. With an Override, a Note and a Not a Transfer mark carried over as well (WRITES_PER_CARRIED, 10) that is 21 for a
 * row with a Rule's Category (11 + 10), and 19 with an Override alone (11 + 8). A row that is paired costs 7 more and is never marked (15 for a paired row
 * replaced where an unpaired one costs 8: WRITES_PER_PAIRED_REMOVED and _IMPORTED). So the day's allowance covers about 12,000 rows replaced at best, about
 * 4,700 when every row has a Rule's Category and all three to carry over (21 each), and about 3,800 if every row is a Transfer with a Rule's Category and an
 * Override and Note as well (11 + 8 + 7 = 26 each), which a household's rows are not. An Account with more imported rows than that cannot be
 * replaced in one day: the Import stops at the limit ("Daily limit reached") and the Admin carries on the next day.
 */
export const REPLACE_SLICE = 5000

/**
 * The IDs of the rows one replace (or one step of clearing) removes: the Account's (?1) oldest Import-sourced rows, at most ?2
 * of them. The removal and the release of those rows' matching Transactions (transfers.ts) both select with this, so they agree
 * on which rows go. Only ever Import-sourced rows: Sync-sourced Transactions are never removed here.
 */
export const IMPORTED_SLICE = "SELECT id FROM transactions WHERE account_id = ?1 AND source = 'import' ORDER BY id LIMIT ?2"

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
