// Applying Rules to Transactions: finds the first Rule (in priority order) that matches each Transaction and stores its
// result on the Transaction's row. One SQL statement, so the Worker never loops over Transactions (ADR 0004).
//
// What it writes: `rule_id`, `rule_category` and `rule_transfer`, only on Transactions a Rule matches (a Transaction that
// no Rule matches is not written, which keeps an Import's writes down). It never writes `override_category` or any other
// column, so an Override is never replaced; the effective Category reads the Override first (effective-category.ts).
//
// Rules are applied to the Transactions an Import adds, one committed chunk at a time (transactions-changed.ts). Applying
// them to all existing history is a later ticket and is not done here.
import { ruleMatches } from './rule-criteria'

/** A Rule counts while it is in use and has somewhere to send a Transaction: the Transfer flag, or a Category still in use. */
const IS_ACTIVE = `r.removed_at IS NULL AND (r.is_transfer = 1 OR EXISTS (SELECT 1 FROM categories c WHERE c.id = r.category_id AND c.removed_at IS NULL))`

// Of the Rules that count and match, the one with the lowest position wins; ties go to the oldest. Transactions with no
// such Rule are left out by the inner join. ?1 is the highest Transaction ID to leave alone, ?2 the Account's ID.
const APPLY = `
  WITH first_match AS (
    SELECT t.id AS transaction_id,
           (SELECT r.id FROM rules r WHERE ${IS_ACTIVE} AND ${ruleMatches('r', 't')} ORDER BY r.position, r.id LIMIT 1) AS rule_id
    FROM transactions t
    WHERE t.id > ?1 AND t.account_id = ?2
  )
  UPDATE transactions
  SET rule_id = hit.id, rule_category = hit.category_id, rule_transfer = CASE WHEN hit.is_transfer = 1 THEN 1 END
  FROM first_match JOIN rules hit ON hit.id = first_match.rule_id
  WHERE transactions.id = first_match.transaction_id`

/** Applies the Rules to the Account's Transactions with an ID above `afterId`. */
export const applyRules = (db: D1Database, scope: { accountId: number; afterId: number }) => db.prepare(APPLY).bind(scope.afterId, scope.accountId).run()
