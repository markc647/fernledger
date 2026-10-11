import type { BankCsvResult } from './bank-csv'
import { api } from './api'
import type { BalanceCheckOutcome } from './balance-check'
import { planChunks } from './import-chunks'
import { HttpError } from './me'

/** A Transaction that lost its Override, Note or Not a Transfer mark, as the Worker reports it. */
export type LostTransaction = { date: string; amountCents: number; description: string; category: string | null; note: string | null; notTransfer: boolean }

export type ImportSummary = {
  added: number
  /** Rows the Account already held (matched by the bank's unique ID), left alone. */
  duplicates: number
  /** Rows in the file that could not be read. */
  skipped: number
  /** Rows dated on or after the Account's Cutover Date, which are not imported. */
  dropped: number
  /** Imported Transactions removed first, when replacing imported history. */
  removed: number
  /** Pairs of Transactions matched as Transfers with another Account's, over every part (worker/transfers.ts). A pair is counted once. */
  paired: number
  /** Transactions given the Override, Note or Not a Transfer mark of the removed Transaction with the same bank unique ID (worker/carry-over.ts), over every part. */
  carried: number
  /** Of those, how many went to a Transaction whose amount is not the removed one's. */
  differing: number
  /** Overrides, Notes and Not a Transfer marks of removed Transactions that no Transaction in the file claimed, which are gone (a replace that finished). */
  lost: number
  /** The Transactions they were on, up to 20 (the Change Log has the same). */
  lostTransactions: LostTransaction[]
  /** Overrides, Notes and Not a Transfer marks still waiting after an Import that was not a replace. */
  stillWaiting: number
  /** How the file's ledger balance compared with the Transactions held, once the last part is saved. */
  balanceCheck: BalanceCheckOutcome | null
}

export type ImportOptions = {
  /** Used only when the Import creates the Account. */
  accountName?: string
  /** Set the Account's Cutover Date to this before importing. */
  cutoverDate?: string
  /** Replace the imported history of this existing Account with the file. */
  replaceAccountId?: number
}

/** The Import stopped part way: `sent` chunks of `total` were saved, and `removed` old rows had been removed when replacing. */
export class ImportStopped extends Error {
  readonly sent: number
  readonly total: number
  readonly removed: number
  /** The free plan's daily database allowance ran out (the Worker answers 429). */
  readonly dailyLimit: boolean
  constructor(sent: number, total: number, cause: unknown, removed = 0) {
    super(`Import stopped after ${sent} of ${total} parts`, { cause })
    this.name = 'ImportStopped'
    this.sent = sent
    this.total = total
    this.removed = removed
    this.dailyLimit = cause instanceof HttpError && cause.status === 429
  }
}

/**
 * Steps of clearing a very large history before the first chunk (5,000 rows each, so more than any Account will hold).
 * Each step is final, and uses 20,000 of the free plan's 100,000 D1 writes a day (a removed row costs 4), so a big
 * history can hit the daily limit part way; the Worker then answers 429 and the Import stops with a daily-limit message.
 */
const MAX_CLEAR_STEPS = 40

/** Sends a parsed file to the Worker one chunk at a time, in order, and adds up what each chunk reports. */
export async function runImport(file: BankCsvResult, options: ImportOptions, onProgress: (sent: number, total: number) => void): Promise<ImportSummary> {
  const chunks = planChunks(file.rows)
  const summary: ImportSummary = { added: 0, duplicates: 0, skipped: file.errors.length, dropped: 0, removed: 0, paired: 0, carried: 0, differing: 0, lost: 0, lostTransactions: [], stillWaiting: 0, balanceCheck: null }
  const replacing = options.replaceAccountId !== undefined

  async function send(index: number, rows: (typeof chunks)[number]) {
    return api.imports.chunks.$post({
      json: {
        account: { number: file.accountNumber, ...(options.accountName ? { name: options.accountName } : {}) },
        chunk: { index, count: chunks.length },
        file: { adapterId: file.adapterId, rowCount: file.rows.length, skipped: file.errors.length, from: file.dateRange.from, to: file.dateRange.to, ledgerBalance: file.ledgerBalance },
        rows,
        // These apply to the whole Import, so they ride on the first chunk only.
        ...(index === 0 && options.cutoverDate ? { cutoverDate: options.cutoverDate } : {}),
        ...(index === 0 && replacing ? { replace: true } : {}),
        // The last part of a replace says so: only then is what no Transaction claimed lost, and what is held cleared.
        ...(index === chunks.length - 1 && replacing ? { completes: true } : {}),
      },
    })
  }

  for (const [index, rows] of chunks.entries()) {
    onProgress(index, chunks.length)
    try {
      let res = await send(index, rows)
      // A history too big to remove with the first chunk is cleared in steps first, then the first chunk is sent again.
      for (let step = 0; index === 0 && replacing && res.status === 409 && step < MAX_CLEAR_STEPS; step++) {
        const cleared = await api.imports['clear-history'].$post({ json: { accountId: options.replaceAccountId! } })
        if (!cleared.ok) throw new HttpError(cleared.status)
        summary.removed += (await cleared.json()).removed
        res = await send(index, rows)
      }
      if (!res.ok) throw new HttpError(res.status)
      const result = await res.json()
      if (!('added' in result)) throw new HttpError(res.status)
      summary.added += result.added
      summary.duplicates += result.duplicates
      summary.dropped += result.dropped
      summary.removed += result.removed
      summary.paired += result.paired
      // The last part says how many were carried over in all, how many went to another amount, and how many were lost or are
      // still waiting (the Worker holds the running totals).
      if (result.carriedTotal !== null) {
        summary.carried = result.carriedTotal
        summary.differing = result.differingAmount ?? 0
        summary.lost = result.lost ?? 0
        summary.lostTransactions = result.lostTransactions
        summary.stillWaiting = result.stillWaiting ?? 0
      }
      if (result.balanceCheck) summary.balanceCheck = result.balanceCheck
    } catch (error) {
      throw new ImportStopped(index, chunks.length, error, summary.removed)
    }
  }
  onProgress(chunks.length, chunks.length)
  return summary
}
