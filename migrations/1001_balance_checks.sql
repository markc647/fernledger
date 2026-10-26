-- Balance Checks: the balance a bank reported for an Account on a date, and how it compared with the Transactions held.
-- One row per Account and date. Money is integer NZD cents; dates are NZ calendar dates, `YYYY-MM-DD`.
--
-- A bank balance "counts" every Transaction dated before its date, plus those dated on it that were saved by the time
-- the balance was recorded (`through_transaction_id`, so a last day the bank had not finished is not mistaken for a
-- missing row). Balance history and the check are both worked out from that one idea (worker/balance-rules.ts).
--
-- `status` is the outcome for the span of time ending at `as_of_date`:
--   matched          the Transactions since the earlier balance (`checked_against`) add up to the bank's change
--   differs          they don't; `difference_cents` is the bank's balance minus the calculated one
--   alone            the only balance whose date the saved Transactions reach, so nothing to compare it with yet
--   after-cutover    on or after the Account's Cutover Date, whose Transactions come from Sync, so not comparable
--   file-ends-early  the file ended before the balance's date, so Transactions up to that date may be missing
-- The last two are kept but never used to compute balances or checks.
--
-- `source` is where the balance came from: 'import' (the file's ledger balance) now, 'sync' (Akahu's balance) when
-- Sync lands. Replacing an Account's imported history removes its 'import' balances.
--
-- Not WITHOUT ROWID: the backup pages tables by rowid.
CREATE TABLE balance_checks (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id             INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  as_of_date             TEXT NOT NULL,
  bank_cents             INTEGER NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('import', 'sync')),
  through_transaction_id INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('matched', 'differs', 'alone', 'after-cutover', 'file-ends-early')),
  checked_against        TEXT,
  calculated_cents       INTEGER,
  difference_cents       INTEGER,
  UNIQUE (account_id, as_of_date)
);
