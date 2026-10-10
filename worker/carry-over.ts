// Carrying Overrides, Notes and Not a Transfer marks (ticket 37) over when an Account's imported history is replaced (ticket 36). The rows that go are
// copied into `carry_over` (migrations/3601_carry_over.sql, 3702_not_a_transfer_carry_over.sql) by the statement that removes them; each chunk of the Import
// gives the rows it saves what is held under the same bank unique ID; the last chunk of a completed replace empties the
// Account's held rows, and the ones nothing claimed are the ones lost.
//
// Everything here is SQL over the chunk's rows, which ride in one bound JSON array exactly as they do for the insert
// (imports.ts): a chunk costs the same few statements however many rows it carries (ADR 0004).
//
// "Matched" means the same bank unique ID as the stored `bank_unique_id`, compared as the Import itself compares it for
// duplicates (imports.ts INSERT_ROWS and COUNT_NEW_ROWS): the browser's adapter has already trimmed it, and the Worker
// stores it as given. Only Import-sourced rows are held and only Import-sourced rows are given anything, so a Sync row
// is never touched (`source = 'import'` in every statement below). ASB's unique ID is the date and a sequence for the day
// (docs/bank-formats/asb.md), so a day the bank has numbered differently since can match a different Transaction: each
// held row remembers its amount, and the Import says how many were given to a Transaction with another amount.

import { IMPORTED_SLICE } from './import-rows'

/** What a replace carries over, as the Change Log and the pages name it. */
export const CARRIED = 'Overrides, Notes and Not a Transfer marks'

/** Categories in use. A removed Category counts as none (GLOSSARY: Uncategorised), so its Override is never carried. */
const IN_USE = 'SELECT id FROM categories WHERE removed_at IS NULL'

/**
 * SQL for "has an Override to a Category in use, a Note or a Not a Transfer mark": what a replace carries over, and what the Replace dialog
 * counts. `alias` is a `transactions` or `carry_over` table in the query (both have these three columns). It is NULL, not
 * false, for a row with none: use it in a WHERE, or wrap it in COALESCE before negating it.
 */
export const annotated = (alias: string) => `(${alias}.note IS NOT NULL OR ${alias}.override_category IN (${IN_USE}) OR ${alias}.not_transfer_with IS NOT NULL)`

/**
 * SQL for "the mark held in `h` can go to `target`" (a `transactions` alias): that Transaction is not paired, and not marked with another number. A mark is
 * never put on a paired Transaction, because its matching Transaction would be left pointing at it; a Transaction that has the mark already (given a
 * moment ago, by the statement that gives it) counts too, so the two statements below agree.
 */
const takesMark = (h: string, target: string) => `(${target}.not_transfer_with IS ${h}.not_transfer_with OR (${target}.transfer_of IS NULL AND ${target}.not_transfer_with IS NULL))`

/** SQL for "`h` has something to give to `target`": a Note, an Override to a Category in use, or a mark the Transaction takes. NULL, like `annotated`, for none. */
const giveable = (h: string, target: string) => `(${h}.note IS NOT NULL OR ${h}.override_category IN (${IN_USE}) OR (${h}.not_transfer_with IS NOT NULL AND ${takesMark(h, target)}))`

/** The Override to keep: the Category, but only while it is in use. */
const liveOverride = (alias: string) => `CASE WHEN ${alias}.override_category IN (${IN_USE}) THEN ${alias}.override_category END`

// Copies the Overrides, Notes and marks of the Account's first ?2 Import-sourced rows (by ID: the rows DELETE_IMPORTED removes
// in the same batch, imports.ts; both select them with IMPORTED_SLICE) into the holding table, with what is needed to say what they were on. A row already
// held (from a replace that did not finish) is brought up to date and made waiting again, so what the Account holds is
// always what it last had. ?1 = the Account.
export const HOLD_REMOVED = `
  INSERT INTO carry_over (account_id, bank_unique_id, override_category, note, not_transfer_with, date, amount_cents, description, category_name)
  SELECT t.account_id, t.bank_unique_id, c.id, t.note, t.not_transfer_with, t.date, t.amount_cents, t.description, c.name
  FROM transactions t LEFT JOIN categories c ON c.id = t.override_category AND c.removed_at IS NULL
  WHERE t.id IN (${IMPORTED_SLICE})
    AND t.bank_unique_id IS NOT NULL AND ${annotated('t')}
  ON CONFLICT (account_id, bank_unique_id) DO UPDATE SET
    override_category = excluded.override_category, note = excluded.note, not_transfer_with = excluded.not_transfer_with, date = excluded.date, amount_cents = excluded.amount_cents,
    description = excluded.description, category_name = excluded.category_name, applied = 0, differs = 0`

/** How many of those rows have something to hold, for the Change Log entry of a step that removes them. Same ?1 and ?2. */
export const COUNT_REMOVED_ANNOTATED = `
  SELECT COUNT(*) AS n FROM transactions t
  WHERE t.id IN (${IMPORTED_SLICE})
    AND t.bank_unique_id IS NOT NULL AND ${annotated('t')}`

// A replace that starts again from the beginning holds the Overrides, Notes and Not a Transfer marks of the rows it removes, including the ones
// an earlier attempt already gave back, so the rows marked as given by that attempt are dropped first or they would be
// counted twice. Rows still waiting are kept: their Transactions are gone and this is all that is left of them.
export const FORGET_APPLIED = 'DELETE FROM carry_over WHERE account_id = ? AND applied = 1'

// Gives the chunk's newly saved rows what is held under their IDs. ?1 = the Account, ?2 = the chunk's rows (JSON). It
// starts from the chunk's IDs and looks each up in the holding table by its key, so its cost follows the chunk, not
// how much is held. A held Category that has been removed since is dropped here, which is why it is not revived. A row
// already given out (`applied`) is never given again, so a Note the Admin has edited since is not written over.
// The mark is copied as it is: both halves of a marked pair hold the same number, so neither needs pointing at the other's new row. It runs before the
// chunk's rows are paired (imports.ts), so a Transaction that comes back marked is never paired. One that is paired already is not marked (`takesMark`),
// so a held row with only a mark is then given nothing, and stays waiting.
export const APPLY_HELD = `
  UPDATE transactions
  SET override_category = ${liveOverride('h')}, note = h.note,
      not_transfer_with = CASE WHEN ${takesMark('h', 'transactions')} THEN COALESCE(transactions.not_transfer_with, h.not_transfer_with) ELSE transactions.not_transfer_with END
  FROM carry_over h
  WHERE h.account_id = ?1 AND h.applied = 0 AND ${giveable('h', 'transactions')}
    AND h.bank_unique_id IN (SELECT json_extract(value, '$.uniqueId') FROM json_each(?2))
    AND transactions.account_id = ?1 AND transactions.source = 'import' AND transactions.bank_unique_id = h.bank_unique_id`

// Marks the held rows the statement above used, and whether the Transaction they went to has another amount. The same
// conditions, so they agree; the last chunk counts what is marked.
export const MARK_APPLIED = `
  UPDATE carry_over
  SET applied = 1,
      differs = (SELECT t.amount_cents IS NOT carry_over.amount_cents FROM transactions t
                 WHERE t.account_id = ?1 AND t.source = 'import' AND t.bank_unique_id = carry_over.bank_unique_id)
  WHERE account_id = ?1 AND applied = 0
    AND bank_unique_id IN (SELECT json_extract(value, '$.uniqueId') FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = ?1 AND t.source = 'import' AND t.bank_unique_id = carry_over.bank_unique_id AND ${giveable('carry_over', 't')})`

/** The last chunk of a completed replace empties the Account's held rows: what it has not given to a Transaction is lost, and was counted. */
export const CLEAR_HELD = 'DELETE FROM carry_over WHERE account_id = ?'

// The last chunk of any other Import drops only what is finished with: rows already given out, and rows with nothing left
// to give (the Admin removed the Category and there is no Note). What still waits stays, for a replace to finish or the
// Admin to discard.
export const TIDY_HELD = `DELETE FROM carry_over WHERE account_id = ?1 AND (applied = 1 OR NOT COALESCE(${annotated('carry_over')}, 0))`

/** Up to this many Transactions are listed in a Change Log entry and on the finished screen's report of what was lost. */
export const LISTED_LOST = 20

// How many Overrides, Notes and Not a Transfer marks the Account has waiting from a replace that did not finish, and the first LISTED_LOST of
// the Transactions they were on (as JSON, oldest first), for the Admin to see before discarding them. ?1 = the Account.
export const WAITING_LIST = `
  SELECT COUNT(*) AS n,
         (SELECT json_group_array(json_object('date', date, 'amountCents', amount_cents, 'description', description, 'category', category_name, 'note', note, 'notTransfer', json(CASE WHEN marked THEN 'true' ELSE 'false' END)))
          FROM (SELECT date, amount_cents, description, category_name, note, not_transfer_with IS NOT NULL AS marked FROM carry_over
                WHERE account_id = ?1 AND applied = 0 AND ${annotated('carry_over')} ORDER BY date, bank_unique_id LIMIT ${LISTED_LOST})) AS listed
  FROM carry_over WHERE account_id = ?1 AND applied = 0 AND ${annotated('carry_over')}`

// What a chunk will carry, worked out before it is saved so its Change Log entry (written in the same batch) can say so.
// It is added to the chunk's row count (imports.ts COUNT_NEW_ROWS), which already reads the chunk's IDs, so it costs no
// D1 query of its own, and it is the same query the Replace question asks with the whole file's IDs (PREVIEW).
// ?2 = the rows (JSON) and ?3 = the Cutover Date or null, as the row count has them; ?4 = the Account whose held rows count
// (null for a new Account); ?5 = the Account about to have its imported history replaced (null otherwise), whose Overrides,
// Notes and Not a Transfer marks are about to be held. `incoming` is the chunk's IDs that will be saved (before the Cutover Date), each with
// its amount; `pending` is every Override, Note and mark waiting to be given: the held ones, and those about to be held.
export const INCOMING_CTE = `
  incoming AS (
    SELECT json_extract(value, '$.uniqueId') AS id, json_extract(value, '$.amountCents') AS cents, MIN(key)
    FROM json_each(?2) WHERE ?3 IS NULL OR json_extract(value, '$.date') < ?3 GROUP BY 1)`

// A row held and a row about to be held for the same ID are one: the hold would bring the held one up to date.
export const PENDING_CTE = `
  pending AS (
    SELECT t.bank_unique_id AS id, t.amount_cents AS cents, t.date AS date, t.description AS description, c.name AS category, t.note AS note,
           t.not_transfer_with IS NOT NULL AS marked
    FROM transactions t LEFT JOIN categories c ON c.id = t.override_category AND c.removed_at IS NULL
    WHERE t.account_id = ?5 AND t.source = 'import' AND t.bank_unique_id IS NOT NULL AND ${annotated('t')}
    UNION ALL
    SELECT h.bank_unique_id, h.amount_cents, h.date, h.description, h.category_name, h.note, h.not_transfer_with IS NOT NULL
    FROM carry_over h
    WHERE h.account_id = ?4 AND h.applied = 0 AND ${annotated('h')}
      AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.account_id = ?5 AND x.source = 'import' AND x.bank_unique_id = h.bank_unique_id))`

// A Sync row that already holds an ID is not given the Override, Note or mark held for it.
const heldBySync = (id: string) => `EXISTS (SELECT 1 FROM transactions s WHERE s.account_id = ?4 AND s.source <> 'import' AND s.bank_unique_id = ${id})`

// A held row with only a mark is not claimed by a Transaction that is paired or marked already (`takesMark`). Only an Import that is not a replace can meet one
// (?5 is null): in a replace the Transactions it would meet are the ones it removes.
const blockedMark = (pending: string, id: string) =>
  `(${pending}.marked AND ${pending}.note IS NULL AND ${pending}.category IS NULL AND ?5 IS NULL AND EXISTS (SELECT 1 FROM transactions x WHERE x.account_id = ?4 AND x.source = 'import' AND x.bank_unique_id = ${id} AND (x.transfer_of IS NOT NULL OR x.not_transfer_with IS NOT NULL)))`

/**
 * Columns for the row count. `carried`: how many pending IDs the rows will claim, and `differing` how many of those have
 * another amount in the file. `waiting`: how many are pending in all. `held`: every row held for the Account, usable or
 * not. `applied` and `appliedDiffering`: how many earlier chunks gave out, and how many of those went to another amount
 * (none when this chunk starts a replace, which holds them again). `lostRows`: when ?6 is 1, up to LISTED_LOST of the
 * pending rows this chunk will not claim, as JSON, oldest first.
 */
export const COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM incoming JOIN pending ON pending.id = incoming.id WHERE NOT ${heldBySync('incoming.id')} AND NOT ${blockedMark('pending', 'incoming.id')}) AS carried,
  (SELECT COUNT(*) FROM incoming JOIN pending ON pending.id = incoming.id WHERE NOT ${heldBySync('incoming.id')} AND NOT ${blockedMark('pending', 'incoming.id')} AND pending.cents IS NOT incoming.cents) AS differing,
  (SELECT COUNT(*) FROM pending) AS waiting,
  (SELECT COUNT(*) FROM carry_over WHERE account_id = ?4) AS heldRows,
  (SELECT COUNT(*) FROM carry_over WHERE account_id = ?4 AND applied = 1 AND ?5 IS NULL) AS applied,
  (SELECT COUNT(*) FROM carry_over WHERE account_id = ?4 AND applied = 1 AND differs = 1 AND ?5 IS NULL) AS appliedDiffering,
  (SELECT json_group_array(json_object('date', date, 'amountCents', cents, 'description', description, 'category', category, 'note', note, 'notTransfer', json(CASE WHEN marked THEN 'true' ELSE 'false' END)))
   FROM (SELECT p.date, p.cents, p.description, p.category, p.note, p.marked FROM pending p
         WHERE ?6 = 1 AND NOT (p.id IN (SELECT id FROM incoming) AND NOT ${heldBySync('p.id')} AND NOT ${blockedMark('p', 'p.id')})
         ORDER BY p.date, p.id LIMIT ${LISTED_LOST})) AS lostRows`

/**
 * The Replace question's forecast: the counts above for a whole file's IDs and amounts (?2, already left without the rows
 * on or after the Cutover Date, so ?3 is null) against the Account's own annotated rows and anything it is holding.
 * ?4 and ?5 are both the Account, ?6 is 0.
 */
export const CARRY_PREVIEW = `WITH ${INCOMING_CTE}, ${PENDING_CTE} SELECT ${COUNT_COLUMNS}`

/** A Transaction whose Override, Note or Not a Transfer mark was lost, as the finished screen and the Change Log list it. */
export type LostRow = { date: string; amountCents: number; description: string; category: string | null; note: string | null; notTransfer: boolean }

/** What the row-count query says about carrying. `lostRows` is JSON text (parseLostRows). */
export type CarryCounts = { carried: number; differing: number; waiting: number; heldRows: number; applied: number; appliedDiffering: number; lostRows: string }

/** The listed Transactions, from the row count's JSON. */
export const parseLostRows = (json: string): LostRow[] => JSON.parse(json) as LostRow[]

/** What a chunk does about carrying over. */
export type CarryPlan = {
  /** Hold the Overrides, Notes and Not a Transfer marks of the rows this chunk removes (the first chunk of a replace). */
  holds: boolean
  /** Give the rows this chunk saves what is held. */
  applies: boolean
  /** Empty the Account's held rows, and report what no Transaction claimed as lost (the last chunk of a replace). */
  clears: boolean
  /** Drop the held rows that are finished with, and report what still waits (the last chunk of any other Import that finds some held). */
  tidies: boolean
  /** The chunk takes part: its Change Log entry and response carry the counts. */
  involved: boolean
}

/**
 * Decides which parts of carrying over a chunk does. A replace always holds, gives out and counts, so what it holds is
 * given out and reported even if the Admin sets a Note in the instant between counting and saving. Any other chunk does
 * something only when the count found held rows (left by a replace that stopped part way), so an ordinary Import
 * costs nothing more. `finishesReplace` is the last chunk of a replace, which alone empties what is held.
 */
export function planCarryOver(chunk: { replacing: boolean; lastChunk: boolean; finishesReplace: boolean }, counts: Pick<CarryCounts, 'waiting' | 'heldRows'>): CarryPlan {
  const holds = chunk.replacing
  const applies = holds || counts.waiting > 0
  const clears = chunk.finishesReplace && (holds || counts.heldRows > 0)
  const tidies = chunk.lastChunk && !chunk.finishesReplace && counts.heldRows > 0
  return { holds, applies, clears, tidies, involved: applies || clears || tidies }
}

/** What a chunk carried, and (on the last chunk of an Import that took part) the totals. */
export type CarryOutcome = {
  /** Transactions this chunk gave an Override, Note or Not a Transfer mark to. */
  carried: number
  /** Last chunk only: Transactions given one in all, across every chunk of the Import. */
  carriedTotal: number | null
  /** Last chunk only: of those, how many went to a Transaction whose amount is not the removed one's. */
  differing: number | null
  /** Last chunk of a replace only: held Overrides, Notes and Not a Transfer marks no Transaction claimed, which are gone. */
  lost: number | null
  /** The Transactions they were on, up to LISTED_LOST. */
  lostRows: LostRow[]
  /** Last chunk of any other Import only: held Overrides, Notes and Not a Transfer marks still waiting for their Transactions. */
  stillWaiting: number | null
}

/**
 * The counts for a chunk's report, or null when it took no part. What was waiting and this chunk did not claim is lost
 * when a replace finishes, and still waiting when another Import does. `carried` is what this chunk claimed: the row count
 * says in advance (for the Change Log entry), and the statement that marked them says afterwards (for the response).
 */
export function carryOutcome(plan: CarryPlan, counts: CarryCounts, lastChunk: boolean, carried: number = counts.carried): CarryOutcome | null {
  if (!plan.involved) return null
  if (!lastChunk) return { carried, carriedTotal: null, differing: null, lost: null, lostRows: [], stillWaiting: null }
  const unclaimed = counts.waiting - carried
  return {
    carried,
    carriedTotal: counts.applied + carried,
    differing: counts.appliedDiffering + counts.differing,
    lost: plan.clears ? unclaimed : null,
    lostRows: plan.clears ? parseLostRows(counts.lostRows) : [],
    stillWaiting: plan.clears ? null : unclaimed,
  }
}

/**
 * The statements of a chunk that give out and clear what is held. The chunk's `prepare` makes each one. `give` runs straight after the insert and the
 * Rules and before the rows are paired, so a mark is on a row before pairing looks at it: give, then mark what was given. `finish` runs after the
 * pairing: clear or tidy.
 */
export function carryStatements<Statement>(
  plan: CarryPlan,
  prepare: { apply: () => Statement; markApplied: () => Statement; clear: () => Statement; tidy: () => Statement },
): { give: Statement[]; finish: Statement[] } {
  return { give: plan.applies ? [prepare.apply(), prepare.markApplied()] : [], finish: plan.clears ? [prepare.clear()] : plan.tidies ? [prepare.tidy()] : [] }
}

const transactions = (n: number) => `${n} ${n === 1 ? 'Transaction' : 'Transactions'}`

/**
 * The part of a Change Log summary about carrying over, with its leading comma, or '' when there is nothing to say. Every
 * part says what it carried; the last says the total, how many went to a Transaction with another amount, and what was
 * lost (a replace) or is still waiting (any other Import).
 */
export function carrySummary(carry: CarryOutcome | null, parts: number): string {
  if (!carry) return ''
  if (carry.carriedTotal === null) return carry.carried > 0 ? `, ${CARRIED} carried over for ${transactions(carry.carried)}` : ''
  const total = carry.carriedTotal
  const unclaimed = carry.lost ?? carry.stillWaiting ?? 0
  if (total === 0 && unclaimed === 0) return ''
  const rest = carry.lost === null ? (unclaimed > 0 ? `, ${unclaimed} still waiting` : '') : unclaimed > 0 ? `, lost for ${transactions(unclaimed)}` : ', none lost'
  const different = carry.differing ? ` (${carry.differing} with a different amount)` : ''
  return `, ${CARRIED} carried over for ${transactions(total)}${parts > 1 ? ' in all' : ''}${different}${rest}`
}

/** The fields of a Change Log entry's detail about carrying over (none for a chunk that took no part). */
export const carryDetail = (carry: CarryOutcome | null) => {
  if (!carry) return {}
  if (carry.carriedTotal === null) return { carried: carry.carried }
  return {
    carried: carry.carried,
    carriedTotal: carry.carriedTotal,
    differingAmount: carry.differing,
    ...(carry.lost !== null ? { lost: carry.lost, lostTransactions: carry.lostRows } : { stillWaiting: carry.stillWaiting }),
  }
}
