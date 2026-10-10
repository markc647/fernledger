-- Budgets (ticket 16): a planned monthly spending amount for a Category, effective from a month onward.
--
-- A row says "from this month on, the Category's Budget is this amount". The Budget in a month M is the row with the
-- latest `effective_from_month` that is on or before M (worker/budget-rules.ts: IN_EFFECT). Setting a new amount from
-- month M adds a row at M (or replaces the row already at M); it never touches a row for an earlier month, so months
-- before M keep the amount they had. Nothing carries over from one month to the next: each month stands alone
-- (README: Budgets; the unrelated "carry over" of Overrides and Notes is 3601_carry_over.sql).
--
--   effective_from_month  'YYYY-MM', an NZ calendar month (Transaction dates are NZ dates, so a month needs no time zone).
--   amount_cents          integer NZD cents, above zero. NULL ends the Budget from that month: the Category then has none
--                         until a later row gives it one. A Budget of $0.00 is not offered: "none" says that better.
--
-- Rows are only added or replaced, never deleted, so the history is whole; the Change Log says who changed what and when.
-- The primary key is also the index the lookup needs: the latest month on or before M for one Category is one seek, however
-- many changes there are (ADR 0004). A Category is never deleted (1101_categories.sql), so the reference always holds, and
-- a removed Category's rows stay but are ignored by everything that reads Budgets.
--
-- A plain rowid table, not WITHOUT ROWID: the weekly backup pages tables by rowid and skips any other kind.
CREATE TABLE budgets (
  category_id          INTEGER NOT NULL REFERENCES categories (id),
  effective_from_month TEXT NOT NULL CHECK (
    effective_from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(effective_from_month, 6, 2) BETWEEN '01' AND '12'
  ),
  amount_cents         INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  PRIMARY KEY (category_id, effective_from_month)
);
