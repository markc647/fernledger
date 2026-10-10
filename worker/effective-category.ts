// The one definition of a Transaction's Category: the first of these that names a Category in use wins.
//   Override (the Admin's hand-set choice) -> Rule -> Akahu's suggested category -> Uncategorised.
// Every query that shows, filters or totals by Category builds from `effectiveCategory`, so they can't disagree.
// It is SQL, not a function over fetched rows, so a list, a filter and a total all run in the database (ADR 0004).
//
// It is also the one definition of a Transfer (`transfer` and `isTransfer` below), because a Transfer is not spending and
// whatever totals, lists or filters by Category has to leave it out the same way. Anything that works out spending uses
// `isTransfer`; nothing re-states "paired, or a Rule marks it, unless the Admin said Not a Transfer" by hand.

export const CATEGORY_SOURCES = ['override', 'rule', 'akahu'] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

/** How a Transaction is a Transfer: 'pair' is paired with one in another Account, 'rule' is marked by a Rule with no pair. */
export type TransferSource = 'pair' | 'rule'

/**
 * `column` holds a Category ID on the Transaction's row, or is null while nothing can supply one yet. It is interpolated
 * into SQL, so it must be a constant written in this file, never anything that came from a request.
 */
export type CategorySlot = { source: CategorySource; column: string | null }

/**
 * In precedence order. A Rule's result is stored on the Transaction when Rules are applied to it (rule-apply.ts).
 * Akahu Sync arrives in a later ticket: it gives its slot a column (`t.akahu_category`) and nothing else here changes.
 */
export const CATEGORY_SLOTS: readonly CategorySlot[] = [
  { source: 'override', column: 't.override_category' },
  { source: 'rule', column: 't.rule_category' },
  { source: 'akahu', column: null },
]

export type EffectiveCategory = {
  /** LEFT JOINs to put after the `transactions` table (aliased `t`), one per slot that has a column. */
  joins: string
  /** SQL for the Category's ID, NULL when Uncategorised. */
  id: string
  /** SQL for the Category's name, NULL when Uncategorised. */
  name: string
  /** SQL for which slot supplied it ('override', ...), NULL when Uncategorised. */
  source: string
  /**
   * SQL for how the Transaction is a Transfer: 'pair' when it is paired with a Transaction in another Account (transfers.ts),
   * 'rule' when a Rule marks it and nothing paired it (the backstop), NULL when it is not a Transfer. A pair outranks the Rule,
   * and an Override outranks both: if the Admin has chosen a Category for this Transaction (one in use), it is spending in that
   * Category, however it is paired. Only that Transaction: its matching Transaction stays a Transfer. "Not a Transfer" outranks all
   * three: once the Admin has said so (`t.not_transfer_with`), neither a pair nor a Rule's Transfer flag makes the Transaction one. Reads
   * `t.transfer_of`, `t.rule_transfer` and `t.not_transfer_with`, and the Override's join, so `joins` must be in the query.
   */
  transfer: string
  /** SQL that is true when the Transaction is a Transfer, so it is left out of spending. Wrap it in NOT for spending. */
  isTransfer: string
  /**
   * `id`, `name` and `source` as a list or a Transaction's details show them: none for a Transfer. A Transfer is not spending, so it has
   * no Category to show, even when a Rule or Akahu would have given it one; showing, sorting or filtering by that Category would make the
   * same Transaction read as a Transfer in one place and as spending in another.
   */
  shown: { id: string; name: string; source: string }
}

/** A slot's Category counts only while it is in use: a removed Category falls through to the next slot. */
export function effectiveCategory(slots: readonly CategorySlot[] = CATEGORY_SLOTS): EffectiveCategory {
  const live = slots.filter((slot): slot is CategorySlot & { column: string } => slot.column !== null)
  const alias = (slot: CategorySlot) => `category_${slot.source}`
  // A Category chosen by hand takes the Transaction out of the Transfers; the Override's Category must be one in use, as it is for the Category itself.
  // So does the Admin's "Not a Transfer", which also stops the pairing and the Rule's flag from making it one again (transfers.ts).
  const override = live.find((slot) => slot.source === 'override')
  const unlessOverridden = override ? `${alias(override)}.id IS NULL` : '1'
  const transfer = `CASE WHEN ${unlessOverridden} AND t.not_transfer_with IS NULL THEN CASE WHEN t.transfer_of IS NOT NULL THEN 'pair' WHEN t.rule_transfer = 1 THEN 'rule' END END`
  const isTransfer = `(${transfer} IS NOT NULL)`
  const unlessTransfer = (sql: string) => `CASE WHEN ${isTransfer} THEN NULL ELSE ${sql} END`
  if (live.length === 0) return { joins: '', id: 'NULL', name: 'NULL', source: 'NULL', transfer, isTransfer, shown: { id: 'NULL', name: 'NULL', source: 'NULL' } }
  // SQLite's COALESCE needs two arguments or more.
  const first = (field: 'id' | 'name') => (live.length === 1 ? `${alias(live[0]!)}.${field}` : `COALESCE(${live.map((slot) => `${alias(slot)}.${field}`).join(', ')})`)
  const id = first('id')
  const name = first('name')
  const source = `CASE ${live.map((slot) => `WHEN ${alias(slot)}.id IS NOT NULL THEN '${slot.source}'`).join(' ')} END`
  return {
    joins: live.map((slot) => `LEFT JOIN categories ${alias(slot)} ON ${alias(slot)}.id = ${slot.column} AND ${alias(slot)}.removed_at IS NULL`).join(' '),
    id,
    name,
    source,
    transfer,
    isTransfer,
    shown: { id: unlessTransfer(id), name: unlessTransfer(name), source: unlessTransfer(source) },
  }
}
