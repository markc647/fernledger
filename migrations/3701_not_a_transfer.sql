-- Not a Transfer (ticket 37): the Admin's answer to a pairing, or a Rule's Transfer flag, that is wrong.
--   not_transfer_with  NULL until the Admin says so. Then a number that both halves of a pair share (the lower of their two IDs), or
--                      a Transaction's own ID when it was marked alone, so that Undo finds the other half by it. Not a foreign key.
-- A marked Transaction is not a Transfer (worker/effective-category.ts) and is left out of pairing (worker/transfers.ts).
ALTER TABLE transactions ADD COLUMN not_transfer_with INTEGER;
