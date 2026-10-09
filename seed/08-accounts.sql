-- Sample data for local development (npm run seed): two made-up bank 99 Accounts and a few Transactions.
-- Safe to run again: it clears these tables first. Change Log entries are left alone.
DELETE FROM transactions;
DELETE FROM accounts;

INSERT INTO accounts (id, account_number, name) VALUES
  (1, '99-9999-9999999-99', 'Savings Example'),
  (2, '99-9999-9999999-98', 'Everyday Example');

INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, type, reference, source, bank_unique_id) VALUES
  (1, '2026-08-31', 120,    'ASB BANK - INTEREST',  'CR.INT TO 31/08/2026', 'INT',    NULL,     'import', '2026083101'),
  (1, '2026-09-04', -820,   'EXAMPLE CAFE TOWN',    'EFTPOS',               'EFTPOS', NULL,     'import', '2026090401'),
  (1, '2026-09-12', 250000, 'EXAMPLE PENSION',      'PENSION',              'D/C',    NULL,     'import', '2026091201'),
  (1, '2026-09-18', -5000,  'J BLOGGS',             'GIFT',                 'CHQ',    '000123', 'import', '2026091801'),
  (2, '2026-09-04', -4599,  'EXAMPLE SUPERMARKET',  'EFTPOS',               'EFTPOS', NULL,     'import', '2026090401'),
  (2, '2026-09-20', -12000, 'EXAMPLE ELECTRICITY',  'DIRECT DEBIT',         'D/D',    NULL,     'import', '2026092001');
