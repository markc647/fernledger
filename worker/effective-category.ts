// The one definition of a Transaction's Category: the first of these that names a Category in use wins.
//   Override (the Admin's hand-set choice) -> Rule -> Akahu's suggested category -> Uncategorised.
// Every query that shows, filters or totals by Category builds from `effectiveCategory`, so they can't disagree.
// It is SQL, not a function over fetched rows, so a list, a filter and a total all run in the database (ADR 0004).

export const CATEGORY_SOURCES = ['override', 'rule', 'akahu'] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

/** `column` holds a Category ID on the Transaction's row, or is null while nothing can supply one yet. */
export type CategorySlot = { source: CategorySource; column: string | null }

/**
 * In precedence order. Rules and Akahu Sync arrive in later tickets: each gives its slot a column (`t.rule_category`,
 * `t.akahu_category`) and nothing else here changes.
 */
export const CATEGORY_SLOTS: readonly CategorySlot[] = [
  { source: 'override', column: 't.override_category' },
  { source: 'rule', column: null },
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
}

/** A slot's Category counts only while it is in use: a removed Category falls through to the next slot. */
export function effectiveCategory(slots: readonly CategorySlot[] = CATEGORY_SLOTS): EffectiveCategory {
  const live = slots.filter((slot): slot is CategorySlot & { column: string } => slot.column !== null)
  if (live.length === 0) return { joins: '', id: 'NULL', name: 'NULL', source: 'NULL' }
  const alias = (slot: CategorySlot) => `category_${slot.source}`
  // SQLite's COALESCE needs two arguments or more.
  const first = (field: 'id' | 'name') => (live.length === 1 ? `${alias(live[0]!)}.${field}` : `COALESCE(${live.map((slot) => `${alias(slot)}.${field}`).join(', ')})`)
  return {
    joins: live.map((slot) => `LEFT JOIN categories ${alias(slot)} ON ${alias(slot)}.id = ${slot.column} AND ${alias(slot)}.removed_at IS NULL`).join(' '),
    id: first('id'),
    name: first('name'),
    source: `CASE ${live.map((slot) => `WHEN ${alias(slot)}.id IS NOT NULL THEN '${slot.source}'`).join(' ')} END`,
  }
}
