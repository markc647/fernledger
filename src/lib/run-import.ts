import type { BankCsvResult } from './bank-csv'
import { api } from './api'
import { planChunks } from './import-chunks'
import { HttpError } from './me'

export type ImportSummary = {
  added: number
  /** Rows the Account already held (matched by the bank's unique ID), left alone. */
  duplicates: number
  /** Rows in the file that could not be read. */
  skipped: number
}

/** The Import stopped part way: `sent` chunks of `total` were saved. Sending the same file again carries on, because rows already held are skipped. */
export class ImportStopped extends Error {
  readonly sent: number
  readonly total: number
  constructor(sent: number, total: number, cause: unknown) {
    super(`Import stopped after ${sent} of ${total} parts`, { cause })
    this.name = 'ImportStopped'
    this.sent = sent
    this.total = total
  }
}

/** Sends a parsed file to the Worker one chunk at a time, in order, and adds up what each chunk reports. */
export async function runImport(
  file: BankCsvResult,
  accountName: string | undefined,
  onProgress: (sent: number, total: number) => void,
): Promise<ImportSummary> {
  const chunks = planChunks(file.rows)
  const summary: ImportSummary = { added: 0, duplicates: 0, skipped: file.errors.length }
  for (const [index, rows] of chunks.entries()) {
    onProgress(index, chunks.length)
    try {
      const res = await api.imports.chunks.$post({
        json: {
          account: { number: file.accountNumber, ...(accountName ? { name: accountName } : {}) },
          chunk: { index, count: chunks.length },
          file: { adapterId: file.adapterId, rowCount: file.rows.length, skipped: file.errors.length, from: file.dateRange.from, to: file.dateRange.to },
          rows,
        },
      })
      if (!res.ok) throw new HttpError(res.status)
      const result = await res.json()
      if (!('added' in result)) throw new HttpError(res.status)
      summary.added += result.added
      summary.duplicates += result.duplicates
    } catch (error) {
      throw new ImportStopped(index, chunks.length, error)
    }
  }
  onProgress(chunks.length, chunks.length)
  return summary
}
