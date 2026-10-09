-- Categories, and the two things the Admin sets by hand on a Transaction: an Override and a Note (ticket 11).
--
-- A Category is never deleted. Removing one sets `removed_at`: that is one row written however many Transactions
-- point at it (ADR 0004: D1 Free allows 100k row writes a day), and the Override stays on record for the Change Log.
-- Anything that reads a Category ignores a removed one, so those Transactions fall through to the next source
-- of a Category, or to Uncategorised. See worker/effective-category.ts.
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  -- UTC time, ISO 8601; NULL while the Category is in use.
  removed_at TEXT
);

-- A name is unique among Categories in use, ignoring case. A removed Category's name can be used again.
CREATE UNIQUE INDEX categories_live_name ON categories (name COLLATE NOCASE) WHERE removed_at IS NULL;

-- The starter list: a household in New Zealand, in plain words. The Admin can rename or remove any of them.
INSERT INTO categories (name) VALUES
  ('Groceries'),
  ('Eating out'),
  ('Fuel'),
  ('Transport'),
  ('Power and gas'),
  ('Rates and water'),
  ('Phone and internet'),
  ('Insurance'),
  ('Health and medical'),
  ('Rent or mortgage'),
  ('Home and garden'),
  ('Clothing'),
  ('Entertainment'),
  ('Gifts and donations'),
  ('Travel'),
  ('Education'),
  ('Bank fees'),
  ('Tax'),
  ('NZ Super and benefits'),
  ('Wages and salary'),
  ('Interest'),
  ('Other income');

-- The names reserved in 0802_transactions.sql. `override_category` is a Category the Admin chose for this Transaction.
ALTER TABLE transactions ADD COLUMN override_category INTEGER REFERENCES categories (id);
ALTER TABLE transactions ADD COLUMN note TEXT;

-- Counting what a removal affects.
CREATE INDEX transactions_override_category ON transactions (override_category) WHERE override_category IS NOT NULL;
