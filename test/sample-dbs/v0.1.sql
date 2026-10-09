-- A made-up Fernledger sample database (scripts/sample-db.mjs). Bank 99 and example.com data only.
CREATE TABLE d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE change_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor   TEXT NOT NULL,
  summary TEXT NOT NULL,
  before  TEXT,
  after   TEXT
);
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL
);
CREATE TABLE transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts (id),
  date           TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  -- What the list shows: the payee, or the bank's memo when the payee is empty.
  description    TEXT NOT NULL,
  bank_memo      TEXT NOT NULL DEFAULT '',
  -- The bank's transaction type, such as EFTPOS or TFR IN.
  bank_type      TEXT NOT NULL DEFAULT '',
  bank_reference TEXT,
  source         TEXT NOT NULL CHECK (source IN ('import', 'sync')),
  -- The bank's own unique ID, used to recognise rows an Import already holds. Unique within an Account.
  bank_unique_id TEXT
);
CREATE UNIQUE INDEX transactions_account_bank_unique_id ON transactions (account_id, bank_unique_id) WHERE bank_unique_id IS NOT NULL;
CREATE INDEX transactions_date ON transactions (date, id);
INSERT INTO "settings" ("key", "value") VALUES ('about_contact', 'Sam Example, sam@example.com');
INSERT INTO "settings" ("key", "value") VALUES ('about_retention', 'Kept until the Admin deletes it');
INSERT INTO "settings" ("key", "value") VALUES ('app_title', 'Example family finances');
INSERT INTO "change_log" ("id", "at", "actor", "summary", "before", "after") VALUES (1, '2026-09-01T02:00:00.000Z', 'admin@example.com', 'Changed the app title', '{"app_title":"Fernledger"}', '{"app_title":"Example family finances"}');
INSERT INTO "change_log" ("id", "at", "actor", "summary", "before", "after") VALUES (2, '2026-09-02T03:30:00.000Z', 'admin@example.com', 'Renamed an Account', '{"name":"Savings"}', '{"name":"Savings Example"}');
INSERT INTO "accounts" ("id", "account_number", "name") VALUES (1, '99-9999-9999999-99', 'Savings Example');
INSERT INTO "accounts" ("id", "account_number", "name") VALUES (2, '99-9999-9999999-98', 'Everyday Example');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (1, 1, '2026-08-31', 120, 'EXAMPLE BANK - INTEREST', 'CR.INT TO 31/08/2026', 'INT', NULL, 'import', '2026083101');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (2, 1, '2026-09-04', -820, 'EXAMPLE CAFE TOWN', 'EFTPOS', 'EFTPOS', NULL, 'import', '2026090401');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (3, 1, '2026-09-12', 250000, 'EXAMPLE PENSION', 'PENSION', 'D/C', NULL, 'import', '2026091201');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (4, 1, '2026-09-18', -5000, 'J BLOGGS', 'GIFT', 'CHQ', '000123', 'import', '2026091801');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (5, 2, '2026-09-04', -4599, 'EXAMPLE SUPERMARKET', 'EFTPOS', 'EFTPOS', NULL, 'import', '2026090401');
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id") VALUES (6, 2, '2026-09-20', -12000, 'EXAMPLE ELECTRICITY', 'DIRECT DEBIT', 'D/D', NULL, 'import', '2026092001');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, '0201_settings.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (2, '0202_change_log.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (3, '0801_accounts.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (4, '0802_transactions.sql', '2026-01-01 00:00:00');
