-- Finding the Transactions a Rule put in a Category (ticket 14), the way 1101_categories.sql's index finds the ones an
-- Override did. A Transaction's Category is its Override or else its Rule's, so the Transactions page's Category filter
-- looks up the candidates in these two indexes instead of reading every Transaction (worker/transaction-search.ts).
-- Partial, so a Transaction no Rule matches (most of them, at first) costs no index entry, and a re-run that clears or
-- changes a Rule's result writes an entry only for the ones that have one.
CREATE INDEX transactions_rule_category ON transactions (rule_category) WHERE rule_category IS NOT NULL;
