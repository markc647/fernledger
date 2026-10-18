// The preview: how many Transactions on file a set of criteria matches, and the newest few, before the Admin saves a Rule.
// It reads and never writes. It matches with the same `ruleMatches` as applying Rules (rule-apply.ts), so the two cannot
// disagree about what a Rule matches.
import { effectiveCategory } from './effective-category'
import { ruleMatches, type Criteria } from './rule-criteria'

/** How many Transactions a preview shows as examples. */
export const PREVIEW_SAMPLES = 5

/** An example Transaction. `bankType` is the bank's own type (Tran Type), which a Rule can match on and the Transactions list does not show. */
export type PreviewSample = { id: number; date: string; description: string; bankType: string; amountCents: number }

// The criteria are not saved, so they stand in for a `rules` row under the same column names.
const CRITERIA = '(SELECT ?1 AS text_contains, ?2 AS bank_type, ?3 AS direction, ?4 AS min_cents, ?5 AS max_cents) r'
const FROM = `FROM transactions t, ${CRITERIA} WHERE ${ruleMatches('r', 't')}`

// The count that also says how many of the matches have no Category: the ones the Uncategorised page lists, which have no Category from an Override or a Rule and are not
// a Transfer (effective-category.ts, the one definition of both). A match looks up the Category of its Override and of its Rule when it has them, which a Transaction that the
// criteria do not match is never asked to do. The criteria come first and `CROSS JOIN` keeps them there: put after the Category joins, the planner reads them again for every
// Transaction (twice the reads).
const category = effectiveCategory()
const COUNT_UNCATEGORISED = `SELECT COUNT(*) AS matches, COALESCE(SUM(${category.id} IS NULL AND NOT ${category.isTransfer}), 0) AS uncategorised
  FROM ${CRITERIA} CROSS JOIN transactions t ${category.joins} WHERE ${ruleMatches('r', 't')}`

/**
 * The statements of a preview, to run in one batch: the count, then the examples. What they read (`meta.rows_read`,
 * pinned in rules.test.ts; the free plan gives 5 million a day): the count reads every Transaction once, and the examples
 * walk the Transactions newest first and stop at the fifth match, so they read only a few more when matches are common and
 * everything again when they are rare, which bounds a preview at twice the Transactions on file. One statement that did
 * both was measured with a window function, a materialised CTE and ordered JSON: each read a common match three or four
 * times over, so none is used.
 *
 * With `uncategorised` the one statement is the count and how many of those have no Category, and there are no examples. That is the count Create Rule shows while the Admin
 * types, so it asks for as little as it can: the one pass over the Transactions, and a look-up of a Category only for a match that has one.
 */
export function previewStatements(db: D1Database, criteria: Criteria, options: { uncategorised?: boolean } = {}) {
  const bound = [criteria.textContains, criteria.bankType, criteria.direction, criteria.minCents, criteria.maxCents]
  if (options.uncategorised) return [db.prepare(COUNT_UNCATEGORISED).bind(...bound)]
  return [
    db.prepare(`SELECT COUNT(*) AS matches ${FROM}`).bind(...bound),
    db.prepare(`SELECT t.id, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents ${FROM} ORDER BY t.date DESC, t.id DESC LIMIT ${PREVIEW_SAMPLES}`).bind(...bound),
  ]
}
