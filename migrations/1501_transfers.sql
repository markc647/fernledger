-- Transfers (ticket 15): money moved between two tracked Accounts is a Transfer, and is not spending.
--
-- A Transaction is a Transfer when it is paired with a Transaction in another Account, or when a Rule marks it as one
-- (`rule_transfer`, 1301_rules.sql). Pairing is worked out in SQL as an Import adds rows (worker/transfers.ts).
--
-- 0802_transactions.sql reserved the name `transfer_pair_id`. It is added as `transfer_of` instead, because what it holds is
-- not the ID of a pair but the ID of the matching Transaction, which reads better in every query that follows it (CODING_STANDARDS.md:
-- Domain language).
--   transfer_of  the ID of the Transaction this one is paired with. Both halves hold the other's ID. NULL while unpaired.
--
-- It is deliberately not a foreign key. A self-referencing key would stop `scripts/restore.mjs` loading the table row by
-- row (a half would name a row not loaded yet), and removing a row would then be refused or cascade into its matching Transaction.
-- Whatever removes Transactions therefore lets go of their matching Transactions in the same batch (worker/transfers.ts); Import's
-- replace and clear-history do. Transaction IDs are never reused (AUTOINCREMENT), so a pointer can't land on the wrong row.
ALTER TABLE transactions ADD COLUMN transfer_of INTEGER;

-- Letting go of the matching Transactions of rows that are being removed finds them by this. Partial, so only paired rows pay a write for it.
CREATE INDEX transactions_transfer_of ON transactions (transfer_of) WHERE transfer_of IS NOT NULL;
