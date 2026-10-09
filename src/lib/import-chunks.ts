import type { MAX_CHUNKS as WORKER_MAX_CHUNKS, MAX_ROWS_PER_CHUNK } from '@/generated/api/import-rows'
import type { BankCsvRow } from './bank-csv'

// The Worker's limits (worker/import-rows.ts; the sizing is explained in worker/imports.ts). Typing these as the
// Worker's literal types makes the build fail if the two sides drift apart.
export const CHUNK_SIZE: typeof MAX_ROWS_PER_CHUNK = 500
export const MAX_CHUNKS: typeof WORKER_MAX_CHUNKS = 20

/** The most rows one Import can carry. */
export const MAX_IMPORT_ROWS = CHUNK_SIZE * MAX_CHUNKS

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
