-- Budgets (ticket 16): a Category's planned monthly spending amount, effective from a month onward.
-- The Budget in month M is the row with the latest `effective_from_month` on or before M (worker/budget-rules.ts), so a new
-- row never changes an earlier month, and nothing carries over. Rows are only added or replaced, never deleted.
--   effective_from_month  'YYYY-MM', an NZ calendar month
--   amount_cents          integer NZD cents above zero; NULL ends the Budget from that month
-- The primary key is the index the lookup needs. A plain rowid table, because the weekly backup skips WITHOUT ROWID tables.
CREATE TABLE budgets (
  category_id          INTEGER NOT NULL REFERENCES categories (id),
  effective_from_month TEXT NOT NULL CHECK (
    effective_from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(effective_from_month, 6, 2) BETWEEN '01' AND '12'
  ),
  amount_cents         INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  PRIMARY KEY (category_id, effective_from_month)
);
