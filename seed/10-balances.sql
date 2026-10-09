-- Sample bank balances for local development (npm run seed): each made-up bank 99 Account from 08-accounts.sql has two,
-- so the Summary has balances to show. "Everyday Example" agrees with its Transactions. "Savings Example" is $5.00 out
-- on purpose, so the Balance Check warning shows. Both Accounts start the history with $1,000.00 and $500.00.
-- Safe to run again: it clears this table first.
DELETE FROM balance_checks;

INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status, checked_against, calculated_cents, difference_cents) VALUES
  (1, '2026-09-15', 349300, 'import', (SELECT MAX(id) FROM transactions), 'alone',   NULL,         NULL,   NULL),
  (1, '2026-09-30', 344800, 'import', (SELECT MAX(id) FROM transactions), 'differs', '2026-09-15', 344300, 500),
  (2, '2026-09-10', 45401,  'import', (SELECT MAX(id) FROM transactions), 'alone',   NULL,         NULL,   NULL),
  (2, '2026-09-30', 33401,  'import', (SELECT MAX(id) FROM transactions), 'matched', '2026-09-10', 33401,  0);
