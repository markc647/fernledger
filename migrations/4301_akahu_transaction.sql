-- Everything else Akahu says about a Synced Transaction (ticket 43). Add-only, nullable columns (ADR 0009). NULL means "not known", never
-- "none": an imported Transaction has all of them NULL, and so does one synced before this migration until a later Sync reaches it. Each Sync
-- writes every column, so a field Akahu stops sending goes back to NULL.

-- Akahu's own category: the NZFCC category and the personal-finance group above it. Card Transactions only. Shown, labelled as Akahu's,
-- and read by nothing else: it never feeds a Category, a Rule, an Override, Uncategorised or a Report.
ALTER TABLE transactions ADD COLUMN akahu_category_id TEXT;
ALTER TABLE transactions ADD COLUMN akahu_category_name TEXT;
ALTER TABLE transactions ADD COLUMN akahu_category_group_id TEXT;
ALTER TABLE transactions ADD COLUMN akahu_category_group_name TEXT;

-- The running balance after this row, in integer cents. Stored, not shown (ticket 30 uses it for the Balance Check).
ALTER TABLE transactions ADD COLUMN akahu_balance_cents INTEGER;

-- Akahu's content hash for the row (scoped to its account), its last-updated and posted dates as Akahu wrote them, and the bank connection
-- (`conn_...`) the row came from. Stored, not shown.
ALTER TABLE transactions ADD COLUMN akahu_hash TEXT;
ALTER TABLE transactions ADD COLUMN akahu_updated_at TEXT;
ALTER TABLE transactions ADD COLUMN akahu_posted_date TEXT;
ALTER TABLE transactions ADD COLUMN akahu_connection_id TEXT;

-- The Bank Time read from the end of the bank's own description (Kiwibank's EFTPOS `-12:07`), as a UTC instant. NULL when the description
-- has none, or the bank is not one whose descriptions are read. It sits beside `akahu_date_raw` and `has_bank_time` rather than in them:
-- those hold what Akahu sent, and this is a reading of the description. The Transaction detail's Bank Time is whichever of the two there is.
ALTER TABLE transactions ADD COLUMN bank_time_from_memo TEXT;
