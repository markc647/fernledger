import type {
  DAILY_ROW_WRITES as WORKER_DAILY_ROW_WRITES,
  MAX_CHUNKS as WORKER_MAX_CHUNKS,
  MAX_ROWS_PER_CHUNK,
  PreviewRow,
  REPLACE_SLICE as WORKER_REPLACE_SLICE,
  WRITES_PER_CARRIED as WORKER_WRITES_PER_CARRIED,
  WRITES_PER_PAIRED_IMPORTED as WORKER_WRITES_PER_PAIRED_IMPORTED,
  WRITES_PER_PAIRED_REMOVED as WORKER_WRITES_PER_PAIRED_REMOVED,
  WRITES_PER_ROW as WORKER_WRITES_PER_ROW,
} from '@/generated/api/import-rows'
import type { BankCsvRow } from './bank-csv'
import { nextDay } from './iso-date'

// The Worker's limits (worker/import-rows.ts; the sizing is explained in worker/imports.ts). Typing these as the
// Worker's literal types makes the build fail if the two sides drift apart.
export const CHUNK_SIZE: typeof MAX_ROWS_PER_CHUNK = 500
export const MAX_CHUNKS: typeof WORKER_MAX_CHUNKS = 20
/** Most imported rows removed in one step when replacing imported history. */
export const REPLACE_SLICE: typeof WORKER_REPLACE_SLICE = 5000
/** The free plan's D1 row writes a day, and what one row costs (the row and its three indexes; worker/import-rows.ts). */
export const DAILY_ROW_WRITES: typeof WORKER_DAILY_ROW_WRITES = 100_000
export const WRITES_PER_ROW: typeof WORKER_WRITES_PER_ROW = 4
/** What carrying one Transaction's Override, Note or Not a Transfer mark over costs at most, on top of its row: 10 with all three (worker/import-rows.ts), 8 for an Override or a mark alone, 6 for a Note alone. */
export const WRITES_PER_CARRIED: typeof WORKER_WRITES_PER_CARRIED = 10
/** What a Transfer costs on top of its row: more to import (both halves are written) and to remove (the matching Transaction is let go of). */
export const WRITES_PER_PAIRED_IMPORTED: typeof WORKER_WRITES_PER_PAIRED_IMPORTED = 4
export const WRITES_PER_PAIRED_REMOVED: typeof WORKER_WRITES_PER_PAIRED_REMOVED = 3

/** The most rows one Import can carry. */
export const MAX_IMPORT_ROWS = CHUNK_SIZE * MAX_CHUNKS

/**
 * About how many of the day's D1 writes it takes to remove `imported` rows and import `incoming` rows, with up to `carried` Overrides
 * and Notes to carry over. `paired` is how many of the imported rows are half of a Transfer: the file that replaces them is
 * taken to bring the same ones back, so each costs to be removed and to be imported again.
 */
export const replaceWrites = (imported: number, incoming: number, carried = 0, paired = 0): number =>
  WRITES_PER_ROW * (imported + incoming) + WRITES_PER_CARRIED * carried + (WRITES_PER_PAIRED_REMOVED + WRITES_PER_PAIRED_IMPORTED) * paired

/** How many rows are dated on or after the Cutover Date, so the preview can say how many an Import will drop. ISO dates compare as text. */
export const countOnOrAfter = (rows: readonly BankCsvRow[], cutoverDate: string | null | undefined): number =>
  cutoverDate ? rows.filter((row) => row.date >= cutoverDate).length : 0

/** The Cutover Date a file puts on offer, and whether the Account's own is already later than it, so the offer cannot be taken. */
export type CutoverOffer = { date: string; alreadyLater: boolean }

/**
 * The Cutover Date the Import screen offers for a file, and whether the Account's own Cutover Date is already later than it, so
 * the offer is shown but cannot be taken.
 *
 * The offer is the day **after** the file's last date. Offering the last date itself dropped every row dated on it, because an
 * Import skips rows on or after the Cutover Date, and it left the file's own ledger balance unchecked, because that balance is
 * dated that same last day. For an Account linked to Akahu that was nearly harmless, since Sync covers the Cutover Date onwards;
 * for one not linked, those Transactions were simply missing, and the balance that would have shown it was skipped too. Found
 * importing real files on 2026-10-20 (#40). The day after is right either way: every row imports, the balance is checked, and
 * Sync still starts where the file stops.
 *
 * The offer cannot be taken when the Account's Cutover Date is already later, which happens when an older file is imported into
 * an Account already imported up to a later date. Taking it would move the boundary backwards, leaving the rows already held
 * on or after the offered date in the ledger (setting a Cutover Date deletes nothing already saved) while Sync claims them from
 * that date too, and nothing dedups across the two sources (ADR 0003). Moving an Account's boundary earlier is done in Settings,
 * deliberately, where the Change Log records it.
 *
 * The date is on offer either way, so the screen can name it while refusing to set it. `fileTo` is a date the adapter produced,
 * so `nextDay` always has one; the fallback keeps the type honest. ISO dates compare as text.
 */
export function cutoverOffer(fileTo: string, accountCutover: string | null | undefined): CutoverOffer {
  const date = nextDay(fileTo) ?? fileTo
  return { date, alreadyLater: accountCutover != null && accountCutover > date }
}

/**
 * Orders rows oldest first (bank unique IDs start with the date and end with a daily sequence, so ordering by
 * date then ID keeps a day's rows in the bank's order), then splits them into chunks.
 */
export function planChunks(rows: readonly BankCsvRow[]): BankCsvRow[][] {
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.uniqueId.localeCompare(b.uniqueId))
  const chunks: BankCsvRow[][] = []
  for (let i = 0; i < ordered.length; i += CHUNK_SIZE) chunks.push(ordered.slice(i, i + CHUNK_SIZE))
  return chunks
}

/**
 * The file's rows as the Replace question sends them to forecast what would carry over: only the bank's unique ID and the
 * amount, without the rows on or after the Cutover Date (which are not imported), each ID once, in chunks of CHUNK_SIZE
 * as an Import is sent (the Worker takes no more than that in a request).
 */
export function previewChunks(rows: readonly BankCsvRow[], cutoverDate: string | null | undefined): PreviewRow[][] {
  const imported = cutoverDate ? rows.filter((row) => row.date < cutoverDate) : rows
  const seen = new Set<string>()
  const chunks: PreviewRow[][] = []
  for (const row of planChunks(imported).flat()) {
    if (seen.has(row.uniqueId)) continue
    seen.add(row.uniqueId)
    if (chunks.length === 0 || chunks[chunks.length - 1]!.length === CHUNK_SIZE) chunks.push([])
    chunks[chunks.length - 1]!.push({ uniqueId: row.uniqueId, amountCents: row.amountCents })
  }
  return chunks
}
