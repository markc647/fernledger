-- When Akahu Sync last reached an Account: an instant in UTC as JavaScript writes it (2026-10-16T01:00:00.000Z). Null until Sync has, which is for every Account until Akahu Sync is built
-- (ADR 0008: Sync is optional). Sync will write it; the Summary and the Dashboard read it for their Sync column (worker/akahu-sync.ts). Add-only (ADR 0009): a nullable column.
-- Numbered 96 for UI ticket U6 (the UI tickets have no issue number to take a range from; U7 would be 97, and so on).
ALTER TABLE accounts ADD COLUMN akahu_synced_at TEXT;
