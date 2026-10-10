// Transfers: money moved between two tracked Accounts, which is not spending.
//
// A Transaction is a Transfer when it is paired with a Transaction in another Account, or when a Rule marks it as one
// and nothing paired it (the backstop). Whether a Transaction counts as a Transfer is decided in ONE place, next to the
// effective Category (effective-category.ts: `transfer` and `isTransfer`), because every query that totals or lists
// spending has to leave Transfers out the same way. This file is how pairs are made, and unmade when a half is removed.
//
// Pairs are made in SQL, one statement for the rows an Import chunk has just added, never by looping over Transactions in
// the Worker (ADR 0004). The statement runs in the chunk's own batch, after the insert and the Rules, so a chunk, its Rule
// results and its pairs commit together or not at all.
//
// What pairs: the same NZ date, equal and opposite amounts, in two different Accounts. Nothing else is looked at, not even the
// description: banks word the two halves of one Transfer differently, and a coincidence between two of the family's own Accounts is
// far more likely to be a Transfer than not. A Transaction pairs with at most one other, and every pair is made of one
// row from each of two different Accounts. A payment to an account that isn't tracked has nothing to pair with, so it stays spending.
//
// When two Transactions are paired that have nothing to do with each other, the Admin says Not a Transfer (ticket 37): both halves stop being paired and are
// marked (`not_transfer_with`), and pairing leaves a marked Transaction out from then on, as the row to pair and as the row to pair it with. Treating them as a
// Transfer again takes the marks off and pairs them again (`PAIR_ONE`), because an Import only pairs the rows it has just added.
import { effectiveCategory } from './effective-category'
import { IMPORTED_SLICE } from './import-rows'

/** Whether something other than the Admin makes a Transaction (aliased `t`) a Transfer, and the Admin has not said Not a Transfer: effective-category.ts has the one definition. */
const MARKABLE = effectiveCategory().markable

/**
 * Pairs the Account's new rows with the unpaired rows of other Accounts. ?1 is the highest Transaction ID to leave alone (the
 * Account's rows above it are the chunk's), ?2 the Account's normalised number.
 *
 * One to one, including identical repeats. Three round-ups of $0.50 out on one day and three of $0.50 in are indistinguishable,
 * so within each group of rows with the same date and amount, the n-th new row (by ID) takes the n-th unpaired row on the other
 * side (by ID). Three and three give three pairs; three and two give two and leave the third out, to be paired when its other
 * half is imported later. Each row is numbered once, so it can't be taken twice. Whichever Account is imported last does the
 * pairing: the new rows look for unpaired rows already there, and rows already there never need to look back.
 *
 * What it reads (`meta.rows_read`, pinned in transfers.test.ts; the free plan gives 5 million a day):
 * - `NOT INDEXED` makes the scan of the Account's rows an ID range, so only the rows above ?1 are read, as rule-apply.ts does.
 * - The other Accounts' rows are found through the date index, one lookup per distinct date in the chunk, so their history on
 *   other days is never read. Rows with another amount on those days are read and dropped.
 *
 * What it writes: the matching Transaction's ID on each half of each pair, and nothing when there are no pairs. The one statement reads the
 * rows to pair before it writes any (UPDATE ... FROM collects its rows first), so a row paired by this statement is not paired twice.
 *
 * A Pending Transaction is stored apart from `transactions` (spec #1), so it is never a candidate here.
 * An amount of nothing never pairs: two empty Transactions are not money moving.
 * A Transaction marked Not a Transfer (`not_transfer_with`) is left out of both `mine` and `others`, so it never pairs and takes no part in the numbering.
 */
export const PAIR = `
  WITH mine AS (
    SELECT t.id, t.date, t.amount_cents,
           ROW_NUMBER() OVER (PARTITION BY t.date, t.amount_cents ORDER BY t.id) AS n
    FROM transactions t NOT INDEXED
    WHERE t.id > ?1 AND t.account_id = (SELECT id FROM accounts WHERE account_number = ?2) AND t.transfer_of IS NULL AND t.not_transfer_with IS NULL AND t.amount_cents <> 0),
  others AS (
    SELECT t.id, t.date, -t.amount_cents AS amount_cents,
           ROW_NUMBER() OVER (PARTITION BY t.date, t.amount_cents ORDER BY t.id) AS n
    FROM transactions t
    WHERE t.date IN (SELECT date FROM mine) AND t.transfer_of IS NULL AND t.not_transfer_with IS NULL
      AND t.account_id <> (SELECT id FROM accounts WHERE account_number = ?2)),
  pairs AS (
    SELECT mine.id AS mine_id, others.id AS other_id
    FROM mine JOIN others ON others.date = mine.date AND others.amount_cents = mine.amount_cents AND others.n = mine.n)
  UPDATE transactions
  SET transfer_of = link.partner
  FROM (SELECT mine_id AS id, other_id AS partner FROM pairs UNION ALL SELECT other_id, mine_id FROM pairs) AS link
  WHERE transactions.id = link.id`

/**
 * LEFT JOINs that give a Transaction (aliased `t`) its matching Transaction (`partner`) and that one's Account (`partner_account`):
 * the list and the details name the Account the money went to or came from. A Transaction with no pair has a NULL `transfer_of`,
 * which finds nothing and reads nothing.
 */
export const PARTNER_JOIN = 'LEFT JOIN transactions partner ON partner.id = t.transfer_of LEFT JOIN accounts partner_account ON partner_account.id = partner.account_id'

/**
 * The statement that pairs the Account's Transactions with an ID above `afterId`. It is not run here: put it in the batch that
 * adds the Transactions (after the insert and the Rules), so they and their pairs commit together. The Account is named by its
 * normalised number, as the Import's insert does, because a first chunk creates the Account in the same batch.
 */
export const pairTransfersStatement = (db: D1Database, scope: { accountNumber: string; afterId: number }) => db.prepare(PAIR).bind(scope.afterId, scope.accountNumber)

/**
 * Lets go of the matching Transactions of the rows a replace (or a step of clearing) is about to remove: ?1 is the Account, ?2 the most
 * rows removed, as `IMPORTED_SLICE` (import-rows.ts) selects them. A row's matching Transaction is never in the same Account, so the removed rows
 * are not written, only their matching Transactions, which are Transactions of other Accounts that stay and are paired again when the
 * replacement has a match. Without this a half would stay a Transfer of a Transaction that no longer exists.
 *
 * Whatever else removes Transactions must do the same in its own batch. Each matching Transaction costs two writes (its row and its entry in
 * the partial Transfer index), up to twice the slice in all, and each removed row one more for its own entry in that index, on top of
 * the removal's own (import-rows.ts: WRITES_PER_PAIRED_REMOVED).
 */
export const UNPAIR_PARTNERS = `UPDATE transactions SET transfer_of = NULL WHERE transfer_of IN (${IMPORTED_SLICE})`

export const unpairPartnersOfImportedStatement = (db: D1Database, scope: { accountId: number; limit: number }) => db.prepare(UNPAIR_PARTNERS).bind(scope.accountId, scope.limit)

/**
 * Says a Transaction is Not a Transfer, and so is the matching Transaction it is paired with: both stop being paired and get the same mark, the lower of
 * their two IDs (`not_transfer_with`), or a Transaction marked alone its own ID. ?1 is the Transaction, ?2 its matching Transaction, or NULL when nothing is
 * paired with it (a Rule makes it a Transfer). It does nothing when what the handler read has moved on, which the count of rows changed says: 2, 1 or 0.
 * An Override and the Rule's own result (`rule_transfer`) are left alone; `isTransfer` stops at the mark. Reads and writes the two rows.
 */
export const MARK_NOT_TRANSFER = `
  UPDATE transactions AS t
  SET not_transfer_with = COALESCE(MIN(?1, ?2), ?1), transfer_of = NULL
  WHERE (t.id = ?1 AND t.transfer_of IS ?2 AND ${MARKABLE})
     OR (t.id = ?2 AND t.transfer_of = ?1 AND t.not_transfer_with IS NULL)`

/** Takes the mark off every Transaction that has it (?1): the Transaction and the one it was marked with. Found by `transactions_not_transfer_with`. */
export const CLEAR_NOT_TRANSFER = 'UPDATE transactions SET not_transfer_with = NULL WHERE not_transfer_with = ?1'

/**
 * Takes the mark (?1) off the rows a replace that has not finished is holding for the Transactions it removed. Without it the half that comes back when the
 * replace is finished would be marked again, though the Admin has taken the mark off the half that stayed, and a mark made later could take the same number.
 * Reads the held rows, which are none except while a replace is unfinished.
 */
export const CLEAR_HELD_NOT_TRANSFER = 'UPDATE carry_over SET not_transfer_with = NULL WHERE not_transfer_with = ?1'

/**
 * Pairs one Transaction (?1) with a match there is now: the same NZ date, the equal and opposite amount, another Account, neither paired nor marked, as `PAIR`
 * requires, and ?2 first if it still qualifies. A Transaction marked with ?3 counts as unmarked: this runs before the mark comes off, in the same batch, so
 * that the batch's last statement is the one that changes the mark and the Change Log entry can wait on it (`onlyIfChanged`). Run it for the Transaction and
 * then for the one it was marked with. Found through the date index, so it reads that day's Transactions, not the history.
 */
export const PAIR_ONE = `
  WITH found AS (
    SELECT a.id AS id,
           (SELECT o.id FROM transactions o
            WHERE o.date = a.date AND o.amount_cents = -a.amount_cents AND o.account_id <> a.account_id AND o.transfer_of IS NULL
              AND (o.not_transfer_with IS NULL OR o.not_transfer_with = ?3)
            ORDER BY o.id IS ?2 DESC, o.id LIMIT 1) AS partner
    FROM transactions a
    WHERE a.id = ?1 AND a.transfer_of IS NULL AND (a.not_transfer_with IS NULL OR a.not_transfer_with = ?3) AND a.amount_cents <> 0),
  pairs AS (SELECT id, partner FROM found WHERE partner IS NOT NULL)
  UPDATE transactions
  SET transfer_of = link.partner
  FROM (SELECT id, partner FROM pairs UNION ALL SELECT partner, id FROM pairs) AS link
  WHERE transactions.id = link.id`

/** Marks the Transaction, and `matchingId` (the Transaction it is paired with, or null), Not a Transfer. */
export const markNotTransferStatement = (db: D1Database, scope: { id: number; matchingId: number | null }) => db.prepare(MARK_NOT_TRANSFER).bind(scope.id, scope.matchingId)

/** Takes the mark `token` off what a replace that has not finished is holding. */
export const clearHeldNotTransferStatement = (db: D1Database, scope: { token: number }) => db.prepare(CLEAR_HELD_NOT_TRANSFER).bind(scope.token)

/** Takes the mark `token` off the Transaction and the one it was marked with. */
export const clearNotTransferStatement = (db: D1Database, scope: { token: number }) => db.prepare(CLEAR_NOT_TRANSFER).bind(scope.token)

/** Pairs the Transaction with a match there is now, `prefer` first, treating the mark `token` as already off. */
export const pairOneStatement = (db: D1Database, scope: { id: number; prefer: number | null; token: number }) => db.prepare(PAIR_ONE).bind(scope.id, scope.prefer, scope.token)
