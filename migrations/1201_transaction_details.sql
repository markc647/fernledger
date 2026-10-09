-- What a Transaction's detail view shows beyond the Import columns (ticket 12). Nullable columns (ADR 0009) that Sync (Akahu)
-- fills and an Import leaves NULL; the Sync ticket writes them and must not add them again.
--
-- 0802_transactions.sql planned some of these as `counterparty_account`, `card_suffix`, `particulars` and `code`. Fields that
-- come straight from the bank are prefixed `bank_` (CODING_STANDARDS.md: Domain language), and a bare `code` would read as
-- source code, so they are added under these names instead:
--
--   bank_counterparty_account  the other party's account number, as the bank gave it
--   bank_card_suffix           the last digits of the card, for a card payment
--   bank_particulars           the payment's Particulars
--   bank_payment_code          the payment's Code (its Reference is `bank_reference`)
--   akahu_date_raw             Akahu's date for the Transaction exactly as received (an ISO 8601 instant, UTC)
--   has_bank_time              1 only when the bank supplied a time of day. Bank Time is `akahu_date_raw`'s time, shown only when this is 1;
--                              NULL or 0 means the raw date's time is a placeholder (usually midnight) and is never shown (GLOSSARY.md: Bank Time)
--   akahu_first_seen_at        when Akahu first reported the Transaction (UTC instant)
ALTER TABLE transactions ADD COLUMN bank_counterparty_account TEXT;
ALTER TABLE transactions ADD COLUMN bank_card_suffix TEXT;
ALTER TABLE transactions ADD COLUMN bank_particulars TEXT;
ALTER TABLE transactions ADD COLUMN bank_payment_code TEXT;
ALTER TABLE transactions ADD COLUMN akahu_date_raw TEXT;
ALTER TABLE transactions ADD COLUMN has_bank_time INTEGER;
ALTER TABLE transactions ADD COLUMN akahu_first_seen_at TEXT;
