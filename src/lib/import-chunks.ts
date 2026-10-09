import type { BankCsvRow } from './bank-csv'

/** Rows per request. The Worker refuses more than this (worker/import-rows.ts) and explains the sizing (worker/imports.ts). */
export const CHUNK_SIZE = 500

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
