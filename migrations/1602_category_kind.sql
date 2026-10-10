-- Category kinds (ticket 16, ADR 0012): each Category is Spending, Income or Loans, and the kind decides how its Transactions are totalled.
-- The Admin sets it on the Categories page. A Category made before this migration is Spending, except the starter income
-- Categories, which become Income. The default is a constant, so the new column costs no row rewrite.
ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'spending' CHECK (kind IN ('spending', 'income', 'loans'));

UPDATE categories SET kind = 'income' WHERE name IN ('Wages and salary', 'NZ Super and benefits', 'Interest', 'Other income');

-- The starter Loans Category. Skipped when the Admin already has a Category by that name (names are unique among those in use),
-- who can set its kind to Loans themselves.
INSERT INTO categories (name, kind) SELECT 'Loans', 'loans' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Loans' COLLATE NOCASE AND removed_at IS NULL);
