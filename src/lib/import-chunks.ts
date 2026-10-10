import type {
  DAILY_ROW_WRITES as WORKER_DAILY_ROW_WRITES,
  MAX_CHUNKS as WORKER_MAX_CHUNKS,
  MAX_ROWS_PER_CHUNK,
  PreviewRow,
  REPLACE_SLICE as WORKER_REPLACE_SLICE,
  WRITES_PER_CARRIED as WORKER_WRITES_PER_CARRIED,
  WRITES_PER_ROW as WORKER_WRITES_PER_ROW,
} from '@/generated/api/import-rows'
import type { BankCsvRow } from './bank-csv'

// The Worker's limits (worker/import-rows.ts; the sizing is explained in worker/imports.ts). Typing these as the
// Worker's literal types makes the build fail if the two sides drift apart.
export const CHUNK_SIZE: typeof MAX_ROWS_PER_CHUNK = 500
export const MAX_CHUNKS: typeof WORKER_MAX_CHUNKS = 20
/** Most imported rows removed in one step when replacing imported history. */
export const REPLACE_SLICE: typeof WORKER_REPLACE_SLICE = 5000
/** The free plan's D1 row writes a day, and what one row costs (the row and its two indexes). */
export const DAILY_ROW_WRITES: typeof WORKER_DAILY_ROW_WRITES = 100_000
export const WRITES_PER_ROW: typeof WORKER_WRITES_PER_ROW = 3
/** What carrying one Transaction's Override or Note over costs at most, on top of its row. */
export const WRITES_PER_CARRIED: typeof WORKER_WRITES_PER_CARRIED = 7

/** The most rows one Import can carry. */
export const MAX_IMPORT_ROWS = CHUNK_SIZE * MAX_CHUNKS

/** About how many of the day's D1 writes it takes to remove `imported` rows and import `incoming` rows, with up to `carried` Overrides and Notes to carry over. */
export const replaceWrites = (imported: number, incoming: number, carried = 0): number => WRITES_PER_ROW * (imported + incoming) + WRITES_PER_CARRIED * carried

/** How many rows are dated on or after the Cutover Date, so the preview can say how many an Import will drop. ISO dates compare as text. */
export const countOnOrAfter = (rows: readonly BankCsvRow[], cutoverDate: string | null | undefined): number =>
  cutoverDate ? rows.filter((row) => row.date >= cutoverDate).length : 0

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
