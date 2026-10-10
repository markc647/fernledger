// Applying Rules to Transactions: finds the first Rule (in priority order) that matches each Transaction and stores its
// result on the Transaction's row. One SQL statement, so the Worker never loops over Transactions (ADR 0004).
//
// What it writes: `rule_id`, `rule_category` and `rule_transfer`, only on Transactions a Rule matches (a Transaction that
// no Rule matches is not written, which keeps an Import's writes down). It never writes `override_category` or any other
// column, so an Override is never replaced; the effective Category reads the Override first (effective-category.ts).
//
// Rules are applied to the Transactions an Import adds, as a statement of the chunk's own batch (imports.ts), so a
// chunk and its Rule results commit together or not at all. Applying them again to all the history already on file is
// rule-rerun.ts, which uses the same definition of "the first Rule that matches" (`firstMatchingRule`) and, unlike this
// statement, also clears `rule_*` on a Transaction that no longer matches any Rule: this one only ever sets them.
import { ruleMatches } from './rule-criteria'

/** The highest Transaction ID, or 0 when there are none. Read it before the batch that adds Transactions, to pass as `afterId`. */
export const lastTransactionId = async (db: D1Database) => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM transactions').first<{ id: number }>())!.id

/** A Rule counts while it is in use and has somewhere to send a Transaction: the Transfer flag, or a Category still in use. `c` is the Rule's Category, if it has one. */
const IS_ACTIVE = `r.removed_at IS NULL AND (r.is_transfer = 1 OR (c.id IS NOT NULL AND c.removed_at IS NULL))`

/**
 * SQL for the ID of the Rule that wins for the Transaction row `transaction` (a table alias, so a constant written in the
 * calling code): of the Rules that count and match, the one with the lowest position; ties go to the oldest. NULL when
 * none does. The one definition, shared by an Import's statement below and by re-running Rules over history (rule-rerun.ts).
 *
 * What it reads (`meta.rows_read`, pinned in rules.test.ts; the free plan gives 5 million a day): the Rules are walked in
 * `rules_position` order and the walk stops at the first match, so a Transaction costs about one read per Rule it has to
 * get past. Putting the Rules into a MATERIALIZED CTE instead was measured: the reads are counted again for every
 * Transaction, and the walk loses its order and so its early stop.
 */
export const firstMatchingRule = (transaction: string) =>
  `(SELECT r.id FROM rules r LEFT JOIN categories c ON c.id = r.category_id
    WHERE ${IS_ACTIVE} AND ${ruleMatches('r', transaction)} ORDER BY r.position, r.id LIMIT 1)`

// Transactions with no matching Rule are left out by the inner join. ?1 is the highest Transaction ID to leave alone, ?2 the Account's number.
// `NOT INDEXED` makes the scan an ID range, so only the rows above ?1 are read. Left to itself SQLite walks the
// Account's whole history through its Account index and throws the old rows away, which is thousands of reads per chunk.
const APPLY = `
  WITH first_match AS (
    SELECT t.id AS transaction_id, ${firstMatchingRule('t')} AS rule_id
    FROM transactions t NOT INDEXED
    WHERE t.id > ?1 AND t.account_id = (SELECT id FROM accounts WHERE account_number = ?2)
  )
  UPDATE transactions
  SET rule_id = hit.id, rule_category = hit.category_id, rule_transfer = CASE WHEN hit.is_transfer = 1 THEN 1 END
  FROM first_match JOIN rules hit ON hit.id = first_match.rule_id
  WHERE transactions.id = first_match.transaction_id`

/**
 * The statement that applies the Rules to the Account's Transactions with an ID above `afterId`. It is not run here:
 * put it in the batch that adds the Transactions (after the insert), so they and their Rule results commit together.
 * The Account is named by its normalised number, as the Import's insert does, because a first chunk creates the Account
 * in the same batch and its ID does not exist yet.
 */
export const applyRulesStatement = (db: D1Database, scope: { accountNumber: string; afterId: number }) => db.prepare(APPLY).bind(scope.afterId, scope.accountNumber)
