-- Kept Reports (UI ticket U7): each time the Admin shows a Report, its CHOICES are kept here, not its figures. Opening a kept Report works it out again from
-- today's data, so nothing is stored that goes stale.
--
--   report        which of the six Reports: 'spending', 'income-vs-spending', 'loans', 'transactions', 'balances' or 'budget-vs-actual' (worker/kept-reports.ts). Not a CHECK: a
--                 constraint can't be changed without DROP (ADR 0009), and the Worker checks it
--   account_id    the Account chosen; NULL is all of them, and a Report with no Account choice (Loans, Budget vs actual) leaves it NULL
--   category_id   the Loans Report's Category; NULL is every Loans Category, and every other Report leaves it NULL
--   from_date     NZ date, both ends included; NULL only for a Loans Report that begins at the first Transaction
--   to_date       NZ date
--   last_made_at  UTC time, ISO 8601, of the last time the Admin showed it
--   made_by       the Admin's email at that time
--
-- No foreign keys, as for a Transfer's pointer (1501_transfers.sql): a kept Report is only choices, and a Category that has since been removed must not stop it being listed.
-- The unique index is what makes showing the same Report with the same choices again update this row and not add another. NULL counts as different from every other NULL in a unique
-- index, so it is over COALESCE of the choices that can be NULL; `report` and `to_date` come first because that is what a Member's read of a Report is checked by.
-- A plain rowid table, because the weekly backup skips WITHOUT ROWID tables.
CREATE TABLE kept_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  report       TEXT NOT NULL CHECK (length(report) > 0),
  account_id   INTEGER,
  category_id  INTEGER,
  from_date    TEXT CHECK (from_date IS NULL OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  to_date      TEXT NOT NULL CHECK (to_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  last_made_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  made_by      TEXT NOT NULL
);

CREATE UNIQUE INDEX kept_reports_choices ON kept_reports (report, to_date, COALESCE(from_date, ''), COALESCE(account_id, 0), COALESCE(category_id, 0));

-- The list is the newest first.
CREATE INDEX kept_reports_last_made ON kept_reports (last_made_at DESC, id DESC);
