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
, type TEXT);
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL
, cutover_date TEXT, akahu_account_id TEXT, akahu_missing_since TEXT, akahu_last_failure TEXT, akahu_name TEXT, akahu_formatted_account TEXT, akahu_status TEXT, akahu_type TEXT, akahu_attributes TEXT, akahu_connection_id TEXT, akahu_connection_name TEXT, akahu_connection_logo TEXT, akahu_connection_type TEXT, akahu_balance_currency TEXT, akahu_balance_current_cents INTEGER, akahu_balance_available_cents INTEGER, akahu_refreshed_balance_at TEXT, akahu_refreshed_meta_at TEXT, akahu_refreshed_transactions_at TEXT, position INTEGER, akahu_synced_at TEXT);
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
, override_category INTEGER REFERENCES categories (id), note TEXT, bank_counterparty_account TEXT, bank_card_suffix TEXT, bank_particulars TEXT, bank_payment_code TEXT, akahu_date_raw TEXT, has_bank_time INTEGER, akahu_first_seen_at TEXT, rule_id INTEGER REFERENCES rules (id), rule_category INTEGER REFERENCES categories (id), rule_transfer INTEGER, transfer_of INTEGER, akahu_id TEXT, merchant TEXT, not_transfer_with INTEGER, akahu_category_id TEXT, akahu_category_name TEXT, akahu_category_group_id TEXT, akahu_category_group_name TEXT, akahu_balance_cents INTEGER, akahu_hash TEXT, akahu_updated_at TEXT, akahu_posted_date TEXT, akahu_connection_id TEXT, bank_time_from_memo TEXT);
CREATE UNIQUE INDEX transactions_account_bank_unique_id ON transactions (account_id, bank_unique_id) WHERE bank_unique_id IS NOT NULL;
CREATE INDEX transactions_date ON transactions (date, id);
CREATE TABLE balance_checks (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id             INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  as_of_date             TEXT NOT NULL,
  bank_cents             INTEGER NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('import', 'sync')),
  through_transaction_id INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('matched', 'differs', 'alone', 'after-cutover', 'file-ends-early')),
  checked_against        TEXT,
  calculated_cents       INTEGER,
  difference_cents       INTEGER,
  UNIQUE (account_id, as_of_date)
);
CREATE INDEX transactions_account_date ON transactions (account_id, date, id);
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  -- UTC time, ISO 8601; NULL while the Category is in use.
  removed_at TEXT
, kind TEXT NOT NULL DEFAULT 'spending' CHECK (kind IN ('spending', 'income', 'loans')));
CREATE UNIQUE INDEX categories_live_name ON categories (name COLLATE NOCASE) WHERE removed_at IS NULL;
CREATE INDEX transactions_override_category ON transactions (override_category) WHERE override_category IS NOT NULL;
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
CREATE INDEX rules_position ON rules (position, id) WHERE removed_at IS NULL;
CREATE TABLE data_migration_progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (length(kind) > 0),
  status           TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped')),
  cursor           INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  end_id           INTEGER NOT NULL CHECK (end_id >= 0),
  total_rows       INTEGER NOT NULL CHECK (total_rows >= 0),
  done_rows        INTEGER NOT NULL DEFAULT 0 CHECK (done_rows >= 0),
  changed_rows     INTEGER NOT NULL DEFAULT 0 CHECK (changed_rows >= 0),
  restarts         INTEGER NOT NULL DEFAULT 0 CHECK (restarts >= 0),
  started_by       TEXT NOT NULL,
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at      TEXT,
  usage_day        TEXT,
  day_rows_read    INTEGER NOT NULL DEFAULT 0 CHECK (day_rows_read >= 0),
  day_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (day_rows_written >= 0)
);
CREATE UNIQUE INDEX data_migration_progress_running ON data_migration_progress (kind) WHERE status = 'running';
CREATE INDEX transactions_rule_category ON transactions (rule_category) WHERE rule_category IS NOT NULL;
CREATE INDEX transactions_transfer_of ON transactions (transfer_of) WHERE transfer_of IS NOT NULL;
CREATE TABLE budgets (
  category_id          INTEGER NOT NULL REFERENCES categories (id),
  effective_from_month TEXT NOT NULL CHECK (
    effective_from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(effective_from_month, 6, 2) BETWEEN '01' AND '12'
  ),
  amount_cents         INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  PRIMARY KEY (category_id, effective_from_month)
);
CREATE UNIQUE INDEX accounts_akahu_account_id ON accounts (akahu_account_id) WHERE akahu_account_id IS NOT NULL;
CREATE UNIQUE INDEX transactions_akahu_id ON transactions (akahu_id) WHERE akahu_id IS NOT NULL;
CREATE TABLE pending_transactions (
  id INTEGER PRIMARY KEY,
  -- ON DELETE CASCADE, as the Balance Checks are (migration 1001): pending money describes an Account, so an Account that goes
  -- takes it with it, and nothing has to remember to clear it first.
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The NZ date, as every date in the app is.
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  bank_type TEXT,
  -- When the Sync that wrote it ran, so the list can say how current the pending money is.
  synced_at TEXT NOT NULL
);
CREATE INDEX pending_transactions_account ON pending_transactions (account_id, date);
CREATE TABLE carry_over (
  account_id        INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  bank_unique_id    TEXT NOT NULL,
  override_category INTEGER,
  note              TEXT,
  applied           INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  differs           INTEGER NOT NULL DEFAULT 0 CHECK (differs IN (0, 1)),
  date              TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  description       TEXT NOT NULL,
  category_name     TEXT, not_transfer_with INTEGER,
  PRIMARY KEY (account_id, bank_unique_id)
);
CREATE INDEX transactions_not_transfer_with ON transactions (not_transfer_with) WHERE not_transfer_with IS NOT NULL;
CREATE TABLE member_read_usage (
  member_key TEXT PRIMARY KEY,
  usage_day  TEXT NOT NULL,
  rows_read  INTEGER NOT NULL CHECK (rows_read >= 0)
, held INTEGER NOT NULL DEFAULT 0, held_count INTEGER NOT NULL DEFAULT 0, held_at INTEGER);
CREATE TRIGGER member_read_usage_one_day AFTER INSERT ON member_read_usage
BEGIN
  DELETE FROM member_read_usage WHERE usage_day < NEW.usage_day;
END;
CREATE TRIGGER member_read_usage_keep_held BEFORE DELETE ON member_read_usage
WHEN OLD.held > 0 AND OLD.held_at >= (SELECT MAX(held_at) FROM member_read_usage) - 60000
BEGIN
  SELECT RAISE(IGNORE);
END;
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
CREATE INDEX kept_reports_last_made ON kept_reports (last_made_at DESC, id DESC);
PRAGMA foreign_keys = OFF;
INSERT INTO "settings" ("key", "value") VALUES ('about_contact', 'Sam Example, sam@example.com');
INSERT INTO "settings" ("key", "value") VALUES ('about_retention', 'Kept until the Admin deletes it');
INSERT INTO "settings" ("key", "value") VALUES ('app_title', 'Example family finances');
INSERT INTO "change_log" ("id", "at", "actor", "summary", "before", "after", "type") VALUES (1, '2026-09-01T02:00:00.000Z', 'admin@example.com', 'Changed the app title', '{"app_title":"Fernledger"}', '{"app_title":"Example family finances"}', NULL);
INSERT INTO "change_log" ("id", "at", "actor", "summary", "before", "after", "type") VALUES (2, '2026-09-02T03:30:00.000Z', 'admin@example.com', 'Renamed an Account', '{"name":"Savings"}', '{"name":"Savings Example"}', NULL);
INSERT INTO "accounts" ("id", "account_number", "name", "cutover_date", "akahu_account_id", "akahu_missing_since", "akahu_last_failure", "akahu_name", "akahu_formatted_account", "akahu_status", "akahu_type", "akahu_attributes", "akahu_connection_id", "akahu_connection_name", "akahu_connection_logo", "akahu_connection_type", "akahu_balance_currency", "akahu_balance_current_cents", "akahu_balance_available_cents", "akahu_refreshed_balance_at", "akahu_refreshed_meta_at", "akahu_refreshed_transactions_at", "position", "akahu_synced_at") VALUES (1, '99-9999-9999999-99', 'Savings Example', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "accounts" ("id", "account_number", "name", "cutover_date", "akahu_account_id", "akahu_missing_since", "akahu_last_failure", "akahu_name", "akahu_formatted_account", "akahu_status", "akahu_type", "akahu_attributes", "akahu_connection_id", "akahu_connection_name", "akahu_connection_logo", "akahu_connection_type", "akahu_balance_currency", "akahu_balance_current_cents", "akahu_balance_available_cents", "akahu_refreshed_balance_at", "akahu_refreshed_meta_at", "akahu_refreshed_transactions_at", "position", "akahu_synced_at") VALUES (2, '99-9999-9999999-98', 'Everyday Example', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (1, 1, '2026-08-31', 120, 'EXAMPLE BANK - INTEREST', 'CR.INT TO 31/08/2026', 'INT', NULL, 'import', '2026083101', 1, 'Example note', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (2, 1, '2026-09-04', -820, 'EXAMPLE CAFE TOWN', 'EFTPOS', 'EFTPOS', NULL, 'import', '2026090401', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (3, 1, '2026-09-12', 250000, 'EXAMPLE PENSION', 'PENSION', 'D/C', NULL, 'import', '2026091201', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (4, 1, '2026-09-18', -5000, 'J BLOGGS', 'GIFT', 'CHQ', '000123', 'import', '2026091801', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (5, 2, '2026-09-04', -4599, 'EXAMPLE SUPERMARKET', 'EFTPOS', 'EFTPOS', NULL, 'import', '2026090401', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "transactions" ("id", "account_id", "date", "amount_cents", "description", "bank_memo", "bank_type", "bank_reference", "source", "bank_unique_id", "override_category", "note", "bank_counterparty_account", "bank_card_suffix", "bank_particulars", "bank_payment_code", "akahu_date_raw", "has_bank_time", "akahu_first_seen_at", "rule_id", "rule_category", "rule_transfer", "transfer_of", "akahu_id", "merchant", "not_transfer_with", "akahu_category_id", "akahu_category_name", "akahu_category_group_id", "akahu_category_group_name", "akahu_balance_cents", "akahu_hash", "akahu_updated_at", "akahu_posted_date", "akahu_connection_id", "bank_time_from_memo") VALUES (6, 2, '2026-09-20', -12000, 'EXAMPLE ELECTRICITY', 'DIRECT DEBIT', 'D/D', NULL, 'import', '2026092001', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "balance_checks" ("id", "account_id", "as_of_date", "bank_cents", "source", "through_transaction_id", "status", "checked_against", "calculated_cents", "difference_cents") VALUES (1, 1, '2026-09-15', 349300, 'import', 6, 'alone', NULL, NULL, NULL);
INSERT INTO "balance_checks" ("id", "account_id", "as_of_date", "bank_cents", "source", "through_transaction_id", "status", "checked_against", "calculated_cents", "difference_cents") VALUES (2, 1, '2026-09-30', 344800, 'import', 6, 'differs', '2026-09-15', 344300, 500);
INSERT INTO "balance_checks" ("id", "account_id", "as_of_date", "bank_cents", "source", "through_transaction_id", "status", "checked_against", "calculated_cents", "difference_cents") VALUES (3, 2, '2026-09-10', 45401, 'import', 6, 'alone', NULL, NULL, NULL);
INSERT INTO "balance_checks" ("id", "account_id", "as_of_date", "bank_cents", "source", "through_transaction_id", "status", "checked_against", "calculated_cents", "difference_cents") VALUES (4, 2, '2026-09-30', 33401, 'import', 6, 'matched', '2026-09-10', 33401, 0);
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (1, 'Groceries', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (2, 'Eating out', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (3, 'Fuel', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (4, 'Transport', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (5, 'Power and gas', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (6, 'Rates and water', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (7, 'Phone and internet', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (8, 'Insurance', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (9, 'Health and medical', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (10, 'Rent or mortgage', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (11, 'Home and garden', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (12, 'Clothing', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (13, 'Entertainment', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (14, 'Gifts and donations', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (15, 'Travel', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (16, 'Education', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (17, 'Bank fees', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (18, 'Tax', NULL, 'spending');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (19, 'NZ Super and benefits', NULL, 'income');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (20, 'Wages and salary', NULL, 'income');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (21, 'Interest', NULL, 'income');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (22, 'Other income', NULL, 'income');
INSERT INTO "categories" ("id", "name", "removed_at", "kind") VALUES (23, 'Loans', NULL, 'loans');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, '0201_settings.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (2, '0202_change_log.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (3, '0801_accounts.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (4, '0802_transactions.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (5, '0901_cutover_date.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (6, '1001_balance_checks.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (7, '1002_transactions_account_date.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (8, '1101_categories.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (9, '1201_transaction_details.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (10, '1301_rules.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (11, '1401_data_migration_progress.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (12, '1402_transactions_rule_category.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (13, '1501_transfers.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (14, '1601_budgets.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (15, '1602_category_kind.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (16, '2401_change_log_type.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (17, '2701_akahu_link.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (18, '2901_pending_and_link.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (19, '3601_carry_over.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (20, '3701_not_a_transfer.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (21, '3702_not_a_transfer_carry_over.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (22, '4201_akahu_account.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (23, '4301_akahu_transaction.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (24, '4501_account_position.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (25, '5001_member_read_usage.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (26, '5002_member_read_holds.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (27, '9601_accounts_akahu_synced_at.sql', '2026-01-01 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (28, '9701_kept_reports.sql', '2026-01-01 00:00:00');
PRAGMA foreign_keys = ON;
