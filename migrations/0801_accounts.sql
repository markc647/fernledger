-- Accounts: one row per tracked bank account, matched by the account number in an Import's file header.
-- `account_number` is normalised `BB-bbbb-AAAAAAA-SS` (the CSV adapters produce it).
-- Later tickets add nullable columns (ADR 0009): akahu_account_id (the Account Link), cutover_date, link_status.
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL
);
