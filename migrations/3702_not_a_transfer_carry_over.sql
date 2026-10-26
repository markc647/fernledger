-- A mark survives a replace of imported history, as Overrides and Notes do (3601_carry_over.sql): it is held with them and given to the
-- row that comes back. The number is copied as it is, so both halves of a pair still share it whichever is replaced.
ALTER TABLE carry_over ADD COLUMN not_transfer_with INTEGER;

-- Undo finds the other half by the number. Partial, so only marked rows pay a write.
CREATE INDEX transactions_not_transfer_with ON transactions (not_transfer_with) WHERE not_transfer_with IS NOT NULL;
