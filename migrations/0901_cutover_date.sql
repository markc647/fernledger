-- Cutover Date (ADR 0003): the NZ calendar date (`YYYY-MM-DD`) on and after which an Account's Transactions come only
-- from Sync. Import drops rows dated on or after it. Null means the Account has none.
ALTER TABLE accounts ADD COLUMN cutover_date TEXT;
