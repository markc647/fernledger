-- Everything Akahu says about a linked Account, kept by each Sync (ticket 42). Add-only, nullable columns (ADR 0009). All NULL for an
-- Account that is not linked, or that Sync has not read the details of yet; unlinking or relinking clears them, because they describe
-- the old link. Each Sync writes every column, so a field Akahu stops sending goes back to NULL. Akahu's account ID is
-- `akahu_account_id` (2701_akahu_link.sql) and is not repeated.
ALTER TABLE accounts ADD COLUMN akahu_name TEXT;
ALTER TABLE accounts ADD COLUMN akahu_formatted_account TEXT;
ALTER TABLE accounts ADD COLUMN akahu_status TEXT;
ALTER TABLE accounts ADD COLUMN akahu_type TEXT;
-- Akahu's attributes, a JSON array of words (["PAYMENT_TO","TRANSACTIONS"]).
ALTER TABLE accounts ADD COLUMN akahu_attributes TEXT;
ALTER TABLE accounts ADD COLUMN akahu_connection_id TEXT;
ALTER TABLE accounts ADD COLUMN akahu_connection_name TEXT;
-- The bank's logo URL on Akahu's CDN. Stored, never drawn or fetched (ADR 0010): the page makes no request to it.
ALTER TABLE accounts ADD COLUMN akahu_connection_logo TEXT;
ALTER TABLE accounts ADD COLUMN akahu_connection_type TEXT;
-- The balance Akahu reports, with its currency, in integer cents of that currency. A record of what Akahu said, never converted or summed (ADR 0006).
ALTER TABLE accounts ADD COLUMN akahu_balance_currency TEXT;
ALTER TABLE accounts ADD COLUMN akahu_balance_current_cents INTEGER;
ALTER TABLE accounts ADD COLUMN akahu_balance_available_cents INTEGER;
-- When Akahu last refreshed each part of the account: instants as Akahu wrote them (ISO 8601).
ALTER TABLE accounts ADD COLUMN akahu_refreshed_balance_at TEXT;
ALTER TABLE accounts ADD COLUMN akahu_refreshed_meta_at TEXT;
ALTER TABLE accounts ADD COLUMN akahu_refreshed_transactions_at TEXT;
