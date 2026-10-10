// The parts of saving one Import chunk that don't touch the request: the Change Log text and the batch of statements.
// Kept apart from the handler (imports.ts) so each can be tested alone.
import { carryDetail, carrySummary, type CarryOutcome } from './carry-over'

/** What a chunk did, as counted before it was saved. */
export type ChunkOutcome = {
  /** The Account's name (or its number for a new one with no name). */
  accountName: string
  replace: boolean
  /** Import-sourced rows removed by a replace. */
  removed: number
  added: number
  /** Rows left out for being dated on or after the Cutover Date. */
  dropped: number
  /** Position of the chunk in its Import, 0-based, and how many chunks there are. */
  index: number
  count: number
  /** What the chunk carried over from the history it replaced (carry-over.ts); null or absent when it took no part. */
  carry?: CarryOutcome | null
}

/** The Change Log summary: every chunk is its own entry, so the log says what was saved even if the Import stops part way. */
export function chunkSummary(outcome: ChunkOutcome): string {
  const part = outcome.count > 1 ? ` (part ${outcome.index + 1} of ${outcome.count})` : ''
  const skipped = outcome.dropped > 0 ? `, skipped ${outcome.dropped} dated on or after the Cutover Date` : ''
  const carried = carrySummary(outcome.carry ?? null, outcome.count)
  return outcome.replace
    ? `Replaced imported history in ${outcome.accountName}: removed ${outcome.removed} rows, imported ${outcome.added} rows${skipped}${carried}${part}`
    : `Imported ${outcome.added} rows into ${outcome.accountName}${skipped}${carried}${part}`
}

/** The Change Log entry's `after`: what the chunk did and what the whole file looked like. */
export function chunkDetail(
  outcome: ChunkOutcome,
  context: { file: { adapterId: string; rowCount: number; skipped: number; from: string; to: string; ledgerBalance: { cents: number; date: string } }; rowsInChunk: number; cutoverDate: string | null; newAccount: boolean },
) {
  const { file } = context
  return {
    adapter: file.adapterId,
    part: outcome.index + 1,
    parts: outcome.count,
    added: outcome.added,
    duplicates: context.rowsInChunk - outcome.dropped - outcome.added,
    dropped: outcome.dropped,
    cutoverDate: context.cutoverDate,
    replaced: outcome.replace,
    removed: outcome.removed,
    ...carryDetail(outcome.carry ?? null),
    fileRows: file.rowCount,
    skipped: file.skipped,
    from: file.from,
    to: file.to,
    ledgerBalance: file.ledgerBalance,
    newAccount: context.newAccount,
  }
}

/** The statements of one chunk, in the order they run in the batch (what is carried over and the last chunk's balance come after them, from the handler). */
export type ChunkPlan = {
  /** The Account is created by the first statement when it doesn't exist yet. */
  newAccount: boolean
  /** The Cutover Date is written by a statement of its own when an existing Account's is being set. */
  setsCutover: boolean
  /** Import-sourced rows, and the balances recorded with them, are deleted before the insert. */
  replace: boolean
}

/**
 * The statements of a chunk, built from `prepare` (one per kind, in this order): create the Account, set its Cutover
 * Date, remove the old balances, forget what an earlier attempt gave out and hold the Overrides and Notes of the rows
 * about to go (carry-over.ts), let go of the matching Transactions of those rows (transfers.ts), remove the old imported rows,
 * insert the rows. The insert is always last, and the removal of rows, when there is one, is just before it, which is how the
 * handler finds their results.
 */
export function chunkStatements<Statement>(
  plan: ChunkPlan,
  prepare: {
    createAccount: () => Statement
    setCutover: () => Statement
    clearBalances: () => Statement
    forgetApplied: () => Statement
    holdRemoved: () => Statement
    unpairPartners: () => Statement
    removeImported: () => Statement
    insertRows: () => Statement
  },
): Statement[] {
  return [
    ...(plan.newAccount ? [prepare.createAccount()] : []),
    ...(plan.setsCutover && !plan.newAccount ? [prepare.setCutover()] : []),
    ...(plan.replace && !plan.newAccount ? [prepare.clearBalances(), prepare.forgetApplied(), prepare.holdRemoved(), prepare.unpairPartners(), prepare.removeImported()] : []),
    prepare.insertRows(),
  ]
}

/** True when a replace would remove old rows and then import none, because every row of the first chunk (the oldest rows) is on or after the Cutover Date. */
export const replaceWouldLeaveNothing = (outcome: { replace: boolean; removed: number; dropped: number; rowsInChunk: number }) =>
  outcome.replace && outcome.removed > 0 && outcome.dropped === outcome.rowsInChunk
