-- An Account's Transactions by date, for the balance queries (worker/balances.ts, worker/balance-check.ts): history,
-- the implied opening balances and the current balance each read one Account's Transactions in date order, and
-- without this they would read every Account's (ADR 0004 limits what a request may read).
CREATE INDEX transactions_account_date ON transactions (account_id, date, id);
