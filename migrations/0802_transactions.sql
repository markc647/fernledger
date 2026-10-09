-- Transactions. Money is integer NZD cents; dates are NZ calendar dates, `YYYY-MM-DD`.
-- Columns that mirror the bank's own data carry a `bank_` prefix so they can't be mistaken for a glossary concept.
--
-- This table is designed for the whole data model (spec #1) but holds only what Import needs. Later tickets add
-- these as nullable columns (ADR 0009), under these names:
--   merchant                                                                      (Sync)
--   akahu_id (with a unique index), akahu_date_raw, akahu_first_seen_at, has_bank_time   (Sync)
--   counterparty_account, card_suffix, particulars, code                          (Sync)
--   akahu_category, rule_category, override_category                              (Categories and Rules)
--   transfer_pair_id                                                              (Transfers)
--   note                                                                          (Notes)
-- `reference` holds a cheque number for an Import; Sync will store the bank's payment reference there.
CREATE TABLE transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts (id),
  date           TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  -- What the list shows: the payee, or the bank's memo when the payee is empty.
  description    TEXT NOT NULL,
  bank_memo      TEXT NOT NULL DEFAULT '',
  -- The bank's transaction type, such as EFTPOS or TFR IN.
  type           TEXT NOT NULL DEFAULT '',
  reference      TEXT,
  source         TEXT NOT NULL CHECK (source IN ('import', 'sync')),
  -- The bank's own unique ID, used to recognise rows an Import already holds. Unique within an Account.
  bank_unique_id TEXT
);

CREATE UNIQUE INDEX transactions_account_bank_unique_id ON transactions (account_id, bank_unique_id) WHERE bank_unique_id IS NOT NULL;
CREATE INDEX transactions_date ON transactions (date, id);
