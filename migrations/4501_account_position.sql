-- Ticket 45: the Admin's order of Accounts, used wherever Accounts are listed (ACCOUNT_ORDER, worker/account-fields.ts).
-- Nullable and left empty, so nothing existing is rewritten (ADR 0009): Accounts with no position follow those with one, by
-- name as before. The first reorder gives every Account a position, and an Account added after it has none, so it goes last.
ALTER TABLE accounts ADD COLUMN position INTEGER;
