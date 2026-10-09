// Carrying Overrides and Notes over when an Account's imported history is replaced (ticket 36). The rows that go are
// copied into `carry_over` (migrations/3601_carry_over.sql) by the statement that removes them; each later chunk of the
// Import gives the rows it saves what is held under the same bank unique ID; the last chunk empties the Account's held
// rows, and the ones nothing claimed are the ones lost.
//
// Everything here is SQL over the chunk's rows, which ride in one bound JSON array exactly as they do for the insert
// (imports.ts): a chunk costs the same few statements however many rows it carries (ADR 0004).
//
// "Matched" means the same bank unique ID as the stored `bank_unique_id`, compared as the Import itself compares it for
// duplicates (imports.ts INSERT_ROWS and COUNT_NEW_ROWS): the browser's adapter has already trimmed it, and the Worker
// stores it as given. Only Import-sourced rows are held and only Import-sourced rows are given anything, so a Sync row
// is never touched (`source = 'import'` in every statement below).

/** Categories in use. A removed Category counts as none (GLOSSARY: Uncategorised), so its Override is never carried. */
const IN_USE = 'SELECT id FROM categories WHERE removed_at IS NULL'

/**
 * SQL for "has an Override to a Category in use, or a Note": what a replace carries over, and what the Replace dialog
 * counts. `alias` is a `transactions` or `carry_over` table in the query (both have these two columns).
 */
export const annotated = (alias: string) => `(${alias}.note IS NOT NULL OR ${alias}.override_category IN (${IN_USE}))`

/** The Override to keep: the Category, but only while it is in use. */
const liveOverride = (alias: string) => `CASE WHEN ${alias}.override_category IN (${IN_USE}) THEN ${alias}.override_category END`

// Copies the Overrides and Notes of the Account's first ?2 Import-sourced rows (by ID: the rows DELETE_IMPORTED removes
// in the same batch, imports.ts) into the holding table. A row already held (from a replace that did not finish) is
// brought up to date and made waiting again, so what the Account holds is always what it last had. ?1 = the Account.
export const HOLD_REMOVED = `
  INSERT INTO carry_over (account_id, bank_unique_id, override_category, note)
  SELECT t.account_id, t.bank_unique_id, ${liveOverride('t')}, t.note
  FROM transactions t
  WHERE t.id IN (SELECT id FROM transactions WHERE account_id = ?1 AND source = 'import' ORDER BY id LIMIT ?2)
    AND t.bank_unique_id IS NOT NULL AND ${annotated('t')}
  ON CONFLICT (account_id, bank_unique_id) DO UPDATE SET override_category = excluded.override_category, note = excluded.note, applied = 0`

/** How many of those rows have something to hold, for the Change Log entry of a step that removes them. Same ?1 and ?2. */
export const COUNT_REMOVED_ANNOTATED = `
  SELECT COUNT(*) AS n FROM transactions t
  WHERE t.id IN (SELECT id FROM transactions WHERE account_id = ?1 AND source = 'import' ORDER BY id LIMIT ?2)
    AND t.bank_unique_id IS NOT NULL AND ${annotated('t')}`

// A replace that starts again from the beginning holds the Overrides and Notes of the rows it removes, including the ones
// an earlier attempt already gave back, so the rows marked as given by that attempt are dropped first or they would be
// counted twice. Rows still waiting are kept: their Transactions are gone and this is all that is left of them.
export const FORGET_APPLIED = 'DELETE FROM carry_over WHERE account_id = ? AND applied = 1'

// Gives the chunk's newly saved rows what is held under their IDs. ?1 = the Account, ?2 = the chunk's rows (JSON). It
// starts from the chunk's IDs and looks each up in the holding table by its key, so its cost follows the chunk, not
// how much is held. A held Category that has been removed since is dropped here, which is why it is not revived.
export const APPLY_HELD = `
  UPDATE transactions
  SET override_category = ${liveOverride('h')}, note = h.note
  FROM carry_over h
  WHERE h.account_id = ?1 AND h.applied = 0 AND ${annotated('h')}
    AND h.bank_unique_id IN (SELECT json_extract(value, '$.uniqueId') FROM json_each(?2))
    AND transactions.account_id = ?1 AND transactions.source = 'import' AND transactions.bank_unique_id = h.bank_unique_id`

// Marks the held rows the statement above used, to be counted by the last chunk. The same conditions, so they agree.
export const MARK_APPLIED = `
  UPDATE carry_over SET applied = 1
  WHERE account_id = ?1 AND applied = 0 AND ${annotated('carry_over')}
    AND bank_unique_id IN (SELECT json_extract(value, '$.uniqueId') FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = ?1 AND t.source = 'import' AND t.bank_unique_id = carry_over.bank_unique_id)`

/** The last chunk empties the Account's held rows: what it has not given to a Transaction is lost, and was counted. */
export const CLEAR_HELD = 'DELETE FROM carry_over WHERE account_id = ?'

// What a chunk will carry, worked out before it is saved so its Change Log entry (written in the same batch) can say so.
// It is added to the chunk's row count (imports.ts COUNT_NEW_ROWS), which already reads the chunk's IDs, so it costs no
// D1 query of its own. ?4 = the Account whose held rows count (null for a new Account); ?5 = the Account about to have its
// imported history replaced (null otherwise), whose Overrides and Notes are about to be held. `incoming` is the chunk's
// IDs that will be saved (before the Cutover Date).
export const PENDING_CTE = `
  pending AS (
    SELECT bank_unique_id AS id FROM carry_over WHERE account_id = ?4 AND applied = 0 AND ${annotated('carry_over')}
    UNION
    SELECT bank_unique_id FROM transactions WHERE account_id = ?5 AND source = 'import' AND bank_unique_id IS NOT NULL AND ${annotated('transactions')})`

/**
 * Columns for the chunk's row count: how many pending IDs the chunk's rows will claim (not one a Sync row already holds),
 * how many are pending in all (the Overrides and Notes still waiting, before this chunk), and how many were given out
 * by earlier chunks (none when this chunk starts a replace, which holds them again).
 */
export const COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM incoming WHERE id IN (SELECT id FROM pending)
     AND NOT EXISTS (SELECT 1 FROM transactions s WHERE s.account_id = ?4 AND s.source <> 'import' AND s.bank_unique_id = incoming.id)) AS carried,
  (SELECT COUNT(*) FROM pending) AS waiting,
  (SELECT COUNT(*) FROM carry_over WHERE account_id = ?4 AND applied = 1 AND ?5 IS NULL) AS applied`

/** What the row-count query says about carrying. */
export type CarryCounts = { carried: number; waiting: number; applied: number }

/** What a chunk does about carrying over, and what it reports. */
export type CarryPlan = {
  /** Hold the Overrides and Notes of the rows this chunk removes (the first chunk of a replace). */
  holds: boolean
  /** Give the rows this chunk saves what is held. */
  applies: boolean
  /** Empty the Account's held rows (the last chunk). */
  clears: boolean
  /** The chunk takes part: its Change Log entry and response carry the counts. */
  involved: boolean
}

/**
 * Decides which parts of carrying over a chunk does. A replace always does all of them, so what it holds is always
 * given out and counted, even if the Admin sets a Note in the instant between counting and saving. Any other chunk does
 * something only when the count found held rows (left by a replace that stopped part way), so an ordinary Import
 * costs nothing more.
 */
export function planCarryOver(chunk: { replacing: boolean; lastChunk: boolean }, counts: CarryCounts): CarryPlan {
  const holds = chunk.replacing
  const applies = holds || counts.waiting > 0
  const clears = chunk.lastChunk && (holds || counts.waiting > 0 || counts.applied > 0)
  return { holds, applies, clears, involved: applies || clears }
}

/** What a chunk carried, and (on the last chunk of an Import that took part) the totals. */
export type CarryOutcome = {
  /** Transactions this chunk gave an Override or Note to. */
  carried: number
  /** Last chunk only: Transactions given one in all, across every chunk of the Import. */
  carriedTotal: number | null
  /** Last chunk only: held Overrides and Notes no Transaction claimed, which are gone. */
  lost: number | null
}

/** The counts for a chunk's report, or null when it took no part. Lost is what was waiting and this chunk did not claim. */
export function carryOutcome(plan: CarryPlan, counts: CarryCounts, lastChunk: boolean): CarryOutcome | null {
  if (!plan.involved) return null
  return lastChunk
    ? { carried: counts.carried, carriedTotal: counts.applied + counts.carried, lost: counts.waiting - counts.carried }
    : { carried: counts.carried, carriedTotal: null, lost: null }
}

/**
 * The statements of a chunk that give out and clear what is held, in the order they run after the insert. The chunk's
 * `prepare` makes each one; the order is the point: give, mark what was given, then clear.
 */
export function carryStatementsAfterInsert<Statement>(plan: CarryPlan, prepare: { apply: () => Statement; markApplied: () => Statement; clear: () => Statement }): Statement[] {
  return [...(plan.applies ? [prepare.apply(), prepare.markApplied()] : []), ...(plan.clears ? [prepare.clear()] : [])]
}

const transactions = (n: number) => `${n} ${n === 1 ? 'Transaction' : 'Transactions'}`

/**
 * The part of a Change Log summary about carrying over, with its leading comma, or '' when there is nothing to say. Every
 * part says what it carried; the last says the total and what was lost.
 */
export function carrySummary(carry: CarryOutcome | null, parts: number): string {
  if (!carry) return ''
  if (carry.carriedTotal === null || carry.lost === null) return carry.carried > 0 ? `, Overrides and Notes carried over for ${transactions(carry.carried)}` : ''
  if (carry.carriedTotal === 0 && carry.lost === 0) return ''
  const inAll = parts > 1 ? ' in all' : ''
  return `, Overrides and Notes carried over for ${transactions(carry.carriedTotal)}${inAll}, lost for ${transactions(carry.lost)}`
}

/** The fields of a Change Log entry's detail about carrying over (none for a chunk that took no part). */
export const carryDetail = (carry: CarryOutcome | null) =>
  carry ? { carried: carry.carried, ...(carry.carriedTotal !== null ? { carriedTotal: carry.carriedTotal, lost: carry.lost } : {}) } : {}
