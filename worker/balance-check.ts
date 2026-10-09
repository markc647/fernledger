// Recording a bank balance and running the Balance Check. The rules are in balance-rules.ts; this is the SQL around them.
// Akahu Sync will call the same two functions with its own balance (source 'sync'); nothing here is Import-specific
// except the name of the source.
import { checkBalances, importOutcome, UNCOUNTED_STATUSES, type BalanceRow, type BalanceStatus, type CheckResult, type ImportOutcome } from './balance-rules'

/** `'after-cutover', 'file-ends-early'` for SQL. Built from constants, never from a request. */
export const UNCOUNTED_SQL = UNCOUNTED_STATUSES.map((status) => `'${status}'`).join(', ')

/** Removes an Account's balances that came from Imports (?1 = the Account's ID), as its imported history is replaced. */
export const DELETE_IMPORT_BALANCES = "DELETE FROM balance_checks WHERE account_id = ? AND source = 'import'"

// Records the bank's balance. `through_transaction_id` is the newest Transaction saved so far, so a Transaction that
// arrives later with the balance's own date (a last day the bank had not finished) is not taken to be in the balance.
// Recording the same date again replaces the balance, and the day's Transactions saved by then count. The statement
// runs after the rows are inserted, in the same batch.
// - An Import never replaces a Sync balance for the same date: Akahu's is the bank's own figure, and an Import's
//   balance dated on or after the Cutover Date is one Sync supersedes. (Sync replacing an Import's is fine.)
// - The balance's check result can't be worked out in this statement (it is the Balance Check's job, run right after),
//   so a counted balance that already had a result keeps it until that refresh succeeds. Were it reset first, a refresh
//   that failed would leave the Summary showing no difference where there is one.
const KEEPS_RESULT = `balance_checks.status IN ('matched', 'differs') AND excluded.status = 'alone'`
const RECORD_BALANCE = `
  INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status)
  VALUES ((SELECT id FROM accounts WHERE account_number = ?1), ?2, ?3, ?4, (SELECT COALESCE(MAX(id), 0) FROM transactions), ?5)
  ON CONFLICT (account_id, as_of_date) DO UPDATE SET
    bank_cents = excluded.bank_cents, source = excluded.source, through_transaction_id = excluded.through_transaction_id,
    status = CASE WHEN ${KEEPS_RESULT} THEN balance_checks.status ELSE excluded.status END,
    checked_against = CASE WHEN ${KEEPS_RESULT} THEN balance_checks.checked_against END,
    calculated_cents = CASE WHEN ${KEEPS_RESULT} THEN balance_checks.calculated_cents END,
    difference_cents = CASE WHEN ${KEEPS_RESULT} THEN balance_checks.difference_cents END
  WHERE NOT (balance_checks.source = 'sync' AND excluded.source = 'import')`

export function recordBalance(
  db: D1Database,
  balance: { accountNumber: string; asOfDate: string; bankCents: number; source: 'import' | 'sync'; status: BalanceStatus },
): D1PreparedStatement {
  return db.prepare(RECORD_BALANCE).bind(balance.accountNumber, balance.asOfDate, balance.bankCents, balance.source, balance.status)
}

// Each balance with its implied opening balance: the bank's balance minus the Transactions it counts (all dated
// before it, and those on its date saved by `through_transaction_id`). One pass over the Account's Transactions
// totals each day, a window function runs the totals, and each balance reads the total before its date.
export const OPENINGS = `
  WITH daily AS MATERIALIZED (
    SELECT date, SUM(amount_cents) AS net FROM transactions WHERE account_id = ?1 GROUP BY date),
  running AS MATERIALIZED (
    SELECT date, SUM(net) OVER (ORDER BY date) AS total FROM daily)
  SELECT b.as_of_date AS asOfDate, b.bank_cents AS bankCents, b.status AS status,
         b.bank_cents
           - COALESCE((SELECT total FROM running WHERE date < b.as_of_date ORDER BY date DESC LIMIT 1), 0)
           - COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE account_id = b.account_id AND date = b.as_of_date AND id <= b.through_transaction_id), 0) AS openingCents
  FROM balance_checks b WHERE b.account_id = ?1 ORDER BY b.as_of_date`

// Writes the results in one statement (the results ride in one bound JSON array, as Import rows do), touching only
// balances whose result changed.
const SAVE_CHECKS = `
  UPDATE balance_checks
  SET status = j.status, checked_against = j.checkedAgainst, calculated_cents = j.calculatedCents, difference_cents = j.differenceCents
  FROM (
    SELECT json_extract(value, '$.asOfDate') AS asOfDate, json_extract(value, '$.status') AS status, json_extract(value, '$.checkedAgainst') AS checkedAgainst,
           json_extract(value, '$.calculatedCents') AS calculatedCents, json_extract(value, '$.differenceCents') AS differenceCents
    FROM json_each(?2)) AS j
  WHERE balance_checks.account_id = ?1 AND balance_checks.as_of_date = j.asOfDate
    AND (balance_checks.status IS NOT j.status OR balance_checks.checked_against IS NOT j.checkedAgainst
         OR balance_checks.calculated_cents IS NOT j.calculatedCents OR balance_checks.difference_cents IS NOT j.differenceCents)`

/**
 * Checks every balance of the Account against the one before it and saves the results, so a mismatch that a new
 * Import fixes clears, and one it creates shows. Two D1 queries (one read, one write). Returns what happened for each balance.
 */
export async function refreshBalanceChecks(db: D1Database, accountId: number): Promise<CheckResult[]> {
  const { results } = await db.prepare(OPENINGS).bind(accountId).all<BalanceRow>()
  const checks = checkBalances(results)
  await db.prepare(SAVE_CHECKS).bind(accountId, JSON.stringify(checks)).run()
  return checks
}

/** The Balance Check after a balance dated `asOfDate` was recorded: refreshes the Account's checks and reports on that balance. */
export async function checkAfterRecording(db: D1Database, accountId: number, asOfDate: string): Promise<ImportOutcome | null> {
  return importOutcome(await refreshBalanceChecks(db, accountId), asOfDate)
}
