-- What a Transaction's detail view shows beyond the Import columns (ticket 12). These are the names 0802_transactions.sql
-- reserved for Sync, added here, as nullable columns (ADR 0009), so the detail view can read them. Sync (Akahu) fills them;
-- an Import leaves them NULL. The Sync ticket writes these columns and must not add them again.
--
--   counterparty_account  the other party's account number, as the bank gave it
--   card_suffix           the last digits of the card, for a card payment
--   particulars, code     the payment's Particulars and Code (its Reference is `bank_reference`)
--   akahu_date_raw        Akahu's date for the Transaction exactly as received (an ISO 8601 instant, UTC)
--   has_bank_time         1 only when the bank supplied a time of day. Bank Time is `akahu_date_raw`'s time, shown only when this is 1;
--                         NULL or 0 means the raw date's time is a placeholder (usually midnight) and is never shown (GLOSSARY.md: Bank Time)
--   akahu_first_seen_at   when Akahu first reported the Transaction (UTC instant)
ALTER TABLE transactions ADD COLUMN counterparty_account TEXT;
ALTER TABLE transactions ADD COLUMN card_suffix TEXT;
ALTER TABLE transactions ADD COLUMN particulars TEXT;
ALTER TABLE transactions ADD COLUMN code TEXT;
ALTER TABLE transactions ADD COLUMN akahu_date_raw TEXT;
ALTER TABLE transactions ADD COLUMN has_bank_time INTEGER;
ALTER TABLE transactions ADD COLUMN akahu_first_seen_at TEXT;
