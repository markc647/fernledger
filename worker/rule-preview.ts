// The preview: how many Transactions on file a set of criteria matches, and the newest few, before the Admin saves a Rule.
// It reads and never writes. It matches with the same `ruleMatches` as applying Rules (rule-apply.ts), so the two cannot
// disagree about what a Rule matches.
import { ruleMatches, type Criteria } from './rule-criteria'

/** How many Transactions a preview shows as examples. */
export const PREVIEW_SAMPLES = 5

/** An example Transaction. `bankType` is the bank's own type (Tran Type), which a Rule can match on and the Transactions list does not show. */
export type PreviewSample = { id: number; date: string; description: string; bankType: string; amountCents: number }

// The criteria are not saved, so they stand in for a `rules` row under the same column names.
const FROM = `FROM transactions t, (SELECT ?1 AS text_contains, ?2 AS bank_type, ?3 AS direction, ?4 AS min_cents, ?5 AS max_cents) r WHERE ${ruleMatches('r', 't')}`

/**
 * The two statements of a preview, to run in one batch: the count, then the examples. What they read (`meta.rows_read`,
 * pinned in rules.test.ts; the free plan gives 5 million a day): the count reads every Transaction once, and the examples
 * walk the Transactions newest first and stop at the fifth match, so they read only a few more when matches are common and
 * everything again when they are rare, which bounds a preview at twice the Transactions on file. One statement that did
 * both was measured with a window function, a materialised CTE and ordered JSON: each read a common match three or four
 * times over, so none is used.
 */
export function previewStatements(db: D1Database, criteria: Criteria) {
  const bound = [criteria.textContains, criteria.bankType, criteria.direction, criteria.minCents, criteria.maxCents]
  return [
    db.prepare(`SELECT COUNT(*) AS matches ${FROM}`).bind(...bound),
    db.prepare(`SELECT t.id, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents ${FROM} ORDER BY t.date DESC, t.id DESC LIMIT ${PREVIEW_SAMPLES}`).bind(...bound),
  ]
}
