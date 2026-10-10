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
// When it does pair two Transactions that have nothing to do with each other, the Admin says "Not a Transfer" (ticket 37). That unpairs both halves and
// marks each (`not_transfer_with`, migrations/3701_not_a_transfer.sql), and a marked Transaction is left out of pairing from then on, as the one to pair and
// as the one to pair with. "Treat as a Transfer again" clears the marks and pairs them again, which is `pairOneStatement`'s job: an Import only pairs the rows
// it has just added, so without it the two would never be looked at again.
import { IMPORTED_SLICE } from './import-rows'

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
 * A Transaction the Admin has marked Not a Transfer (`not_transfer_with`) never pairs, whether it is new or already there: it is left out of both
 * `mine` and `others`, so it takes no part in the numbering that matches the n-th with the n-th and can't be given to another row.
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
 * Says a Transaction is Not a Transfer, and so is the matching Transaction it is paired with: both are unpaired and marked in this one statement, each
 * holding the other's ID in `not_transfer_with`. ?1 is the Transaction, ?2 the ID of its matching Transaction, or NULL when nothing is paired with it
 * (a Rule marks it a Transfer and nothing paired it), in which case it is marked alone and holds its own ID.
 *
 * It changes nothing when what the handler read has moved on since: a half that is already marked, a pairing that is no longer between these two (an
 * Import replaced one of them), or, for a Transaction with no match, one that no Rule marks. The handler tells the Admin so from the count of rows
 * changed (two for a pair, one alone, none when stale).
 *
 * The Rule's result (`rule_transfer`) and an Override are left as they are. Marking is why a Rule's Transfer flag no longer applies: `isTransfer`
 * (effective-category.ts) stops at the marker, so treating the Transaction as a Transfer again hands the Rule's flag back with nothing re-applied.
 *
 * It reads and writes the two rows (each with its entry in the partial Transfer index, which loses it), however long the history is.
 */
export const MARK_NOT_TRANSFER = `
  UPDATE transactions
  SET not_transfer_with = CASE WHEN id = ?1 THEN COALESCE(?2, ?1) ELSE ?1 END, transfer_of = NULL
  WHERE not_transfer_with IS NULL
    AND ((id = ?1 AND transfer_of IS ?2 AND (?2 IS NOT NULL OR rule_transfer = 1)) OR (id = ?2 AND transfer_of = ?1))`

/**
 * Takes the mark off a Transaction and, if the other half still holds a mark that names it, off that one too. ?1 is the Transaction, ?2 the ID it was
 * marked together with (its `not_transfer_with`), or NULL when it was marked alone. Nothing is paired: that is `PAIR_ONE`, next in the same batch.
 * A half whose mark names some other Transaction is left alone, which can only happen if IDs were reused, and they are not.
 */
export const CLEAR_NOT_TRANSFER = `
  UPDATE transactions
  SET not_transfer_with = NULL
  WHERE not_transfer_with IS NOT NULL AND (id = ?1 OR (id = ?2 AND not_transfer_with = ?1))`

/**
 * Pairs one Transaction with a match that is there now: the same NZ date, the equal and opposite amount, another Account, and neither paired nor marked
 * Not a Transfer, as `PAIR` requires of the rows it pairs. ?1 is the Transaction; ?2 is the match to take when it still qualifies (the Transaction it was just
 * unpaired from), or NULL; any other match is the one with the lowest ID, as `PAIR` takes the first unpaired row. It pairs nothing when ?1 is already paired,
 * or marked, or has no match, and then writes nothing.
 *
 * An Import only pairs the rows it has just added, so a Transaction that was marked is never looked at again by one: treating it as a Transfer again has to
 * pair it here, in the same batch as the marks coming off, or it would stay unpaired for good. The match is found through the date index, so what this reads
 * is the Transactions of that one day in every Account, however long the history is (pinned in not-a-transfer.test.ts).
 *
 * Run it for the Transaction and then for its former match: the second does nothing when the first paired them, and finds a match of its own when the first
 * took another.
 */
export const PAIR_ONE = `
  WITH found AS (
    SELECT a.id AS id,
           (SELECT o.id FROM transactions o
            WHERE o.date = a.date AND o.amount_cents = -a.amount_cents AND o.account_id <> a.account_id AND o.transfer_of IS NULL AND o.not_transfer_with IS NULL
            ORDER BY o.id IS ?2 DESC, o.id LIMIT 1) AS partner
    FROM transactions a
    WHERE a.id = ?1 AND a.transfer_of IS NULL AND a.not_transfer_with IS NULL AND a.amount_cents <> 0),
  pairs AS (SELECT id, partner FROM found WHERE partner IS NOT NULL)
  UPDATE transactions
  SET transfer_of = link.partner
  FROM (SELECT id, partner FROM pairs UNION ALL SELECT partner, id FROM pairs) AS link
  WHERE transactions.id = link.id`

/** Marks the Transaction, and `matchingId` (the Transaction it is paired with, or null), Not a Transfer. */
export const markNotTransferStatement = (db: D1Database, scope: { id: number; matchingId: number | null }) => db.prepare(MARK_NOT_TRANSFER).bind(scope.id, scope.matchingId)

/** Takes the mark off the Transaction and `matchingId` (the Transaction it was marked together with, or null). */
export const clearNotTransferStatement = (db: D1Database, scope: { id: number; matchingId: number | null }) => db.prepare(CLEAR_NOT_TRANSFER).bind(scope.id, scope.matchingId)

/** Pairs the Transaction with a match that is there now, preferring `prefer`. */
export const pairOneStatement = (db: D1Database, scope: { id: number; prefer: number | null }) => db.prepare(PAIR_ONE).bind(scope.id, scope.prefer)
