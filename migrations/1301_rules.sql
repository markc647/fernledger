-- Rules (ticket 13): an Admin-defined pattern that gives matching Transactions a Category, or marks them as Transfers.
--
-- A Rule is never deleted. Removing one sets `removed_at`, because Transactions it categorised point at it (`rule_id`)
-- and the Change Log keeps its before/after. Anything that reads Rules ignores a removed one.
--
-- Criteria are optional, and a Rule matches only when every criterion it uses matches (worker/rule-criteria.ts):
--   text_contains  case-insensitive, found in the Transaction's description or its bank memo
--   bank_type      the bank's transaction type, equal ignoring case (EFTPOS, not a part of it)
--   direction      'in' (amount above zero) or 'out' (below zero); NULL means either
--   min_cents, max_cents  the SIZE of the amount, so a $50 refund and a $50 purchase both count as 5000. Inclusive.
-- At least one criterion is needed: a Rule with none would match every Transaction.
--
-- The target is a Category, or the Transfer flag. `category_id` may name a Category that has since been removed;
-- the Rule then does nothing (see worker/rule-apply.ts) and the Rules page says so.
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Priority: the lowest `position` that matches wins. Ties are broken by `id`.
  position      INTEGER NOT NULL,
  text_contains TEXT CHECK (text_contains IS NULL OR length(text_contains) > 0),
  bank_type     TEXT CHECK (bank_type IS NULL OR length(bank_type) > 0),
  direction     TEXT CHECK (direction IS NULL OR direction IN ('in', 'out')),
  min_cents     INTEGER CHECK (min_cents IS NULL OR min_cents >= 0),
  max_cents     INTEGER CHECK (max_cents IS NULL OR max_cents >= 0),
  category_id   INTEGER REFERENCES categories (id),
  is_transfer   INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0, 1)),
  -- UTC time, ISO 8601; NULL while the Rule is in use.
  removed_at    TEXT,
  CHECK (text_contains IS NOT NULL OR bank_type IS NOT NULL OR direction IS NOT NULL OR min_cents IS NOT NULL OR max_cents IS NOT NULL),
  CHECK ((category_id IS NOT NULL) <> (is_transfer = 1))
);

-- Reading the Rules in priority order.
CREATE INDEX rules_position ON rules (position, id) WHERE removed_at IS NULL;

-- A Transaction's stored Rule result, written when Rules are applied to it (worker/rule-apply.ts), in the names
-- reserved in 0802_transactions.sql. They are NULL until a Rule matches. Rules are applied to new Transactions as an
-- Import adds them; re-running Rules over existing history comes in a later release, so until then a result stays
-- as it was when it was stored, even if its Rule is later changed or removed.
--   rule_id        the Rule that matched (the first, in priority order)
--   rule_category  that Rule's Category: the Rule slot of the effective Category (worker/effective-category.ts)
--   rule_transfer  1 when that Rule marks Transfers, else NULL. Transfer pairing (a later ticket) reads it as the Rule
--                  backstop: a Transaction with this set is a Transfer even with no pair.
ALTER TABLE transactions ADD COLUMN rule_id INTEGER REFERENCES rules (id);
ALTER TABLE transactions ADD COLUMN rule_category INTEGER REFERENCES categories (id);
ALTER TABLE transactions ADD COLUMN rule_transfer INTEGER;
