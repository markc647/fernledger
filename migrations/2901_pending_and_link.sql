-- Ticket 29 (#30): Pending Transactions, why a Sync of an Account did not finish, and the Account Link Akahu has stopped returning.
--
-- Pending Transactions get a table of their own rather than a flag on `transactions`: they are replaced whole on every Sync and
-- must never reach a Budget, a Report or any total (spec 55, 56), and nothing that already reads `transactions` has to learn
-- about them to leave them out. Akahu's pending model carries no `_id`, so there is no key to match a row on and nothing to
-- update: a Sync deletes what it holds for the linked Accounts and writes what Akahu has now.
CREATE TABLE pending_transactions (
  id INTEGER PRIMARY KEY,
  -- ON DELETE CASCADE, as the Balance Checks are (migration 1001): pending money describes an Account, so an Account that goes
  -- takes it with it, and nothing has to remember to clear it first.
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The NZ date, as every date in the app is.
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  bank_type TEXT,
  -- When Akahu last changed the row, if it said.
  akahu_updated_at TEXT,
  -- When the Sync that wrote it ran, so the list can say how current the pending money is.
  synced_at TEXT NOT NULL
);

CREATE INDEX pending_transactions_account ON pending_transactions (account_id, date);

-- When Akahu first stopped listing a linked Account, which is "Account Link broken" (spec 32). Null while Akahu still lists it.
-- The Account's Transactions are never deleted because of it, and the Admin re-links it from the Accounts screen.
ALTER TABLE accounts ADD COLUMN akahu_missing_since TEXT;

-- Why the last Sync of this Account did not finish: 'refused', 'unreachable' or 'unreadable' (worker/akahu.ts names them), so the
-- Sync status can say the cause and what to do about it (spec 59). Cleared when a Sync of the Account finishes.
ALTER TABLE accounts ADD COLUMN akahu_last_failure TEXT;
