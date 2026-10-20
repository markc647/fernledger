-- The Account Link and what Sync needs to save a Transaction by Akahu's ID (ticket 27). Add-only, nullable columns (ADR 0009).
-- 0801_accounts.sql and 0802_transactions.sql planned these; this is where they arrive. 1201_transaction_details.sql already added
-- the payment details Sync fills (bank_counterparty_account, bank_card_suffix, bank_particulars, bank_payment_code, akahu_date_raw,
-- has_bank_time, akahu_first_seen_at), so they are not added again.

-- The Akahu account this Account receives Sync from, Akahu's own ID (`acc_...`). NULL for an Account that is not linked, which is
-- every Account until the Admin links one: Sync is optional per Account (ADR 0008) and only linked Accounts are ever stored (spec 31).
ALTER TABLE accounts ADD COLUMN akahu_account_id TEXT;

-- One Akahu account feeds at most one Account: linking the same one twice would sync the same Transactions into two Accounts.
-- Partial, so the unlinked Accounts (all NULL) do not collide.
CREATE UNIQUE INDEX accounts_akahu_account_id ON accounts (akahu_account_id) WHERE akahu_account_id IS NOT NULL;

-- Akahu's own ID for the Transaction (`trans_...`), which is what makes a Sync safe to repeat (spec 48): a re-run of an overlapping
-- window updates the row it already has instead of adding a second. NULL for every imported Transaction.
ALTER TABLE transactions ADD COLUMN akahu_id TEXT;

-- Unique across the table, not per Account: Akahu's IDs are unique in themselves, and the Account is decided by the link, so the same
-- Akahu Transaction must never exist twice whatever Account it was first seen on. This index is also what ON CONFLICT targets.
CREATE UNIQUE INDEX transactions_akahu_id ON transactions (akahu_id) WHERE akahu_id IS NOT NULL;

-- The merchant Akahu recognised, when it recognised one (0802_transactions.sql planned it as `merchant`). `description` holds the
-- merchant's name when there is one and the bank's own description otherwise, so this records which of the two it was.
ALTER TABLE transactions ADD COLUMN merchant TEXT;
