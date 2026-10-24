-- Carry over (ticket 36): replacing an Account's imported history removes its Import-sourced Transactions, and with
-- them any Override or Note the Admin set. Before the rows go, each one that has an Override (to a Category in use) or
-- a Note is copied here, keyed by the bank's own number for the Transaction (`bank_unique_id`). Each chunk of the Import
-- then gives the rows it saves the Override and Note held under the same number (worker/carry-over.ts).
--
-- Rows are held only while a replace is under way, so the table is normally empty. The last chunk of a replace empties
-- the Account's rows here; the ones no Transaction claimed are lost, and are counted and listed in the Change Log. The
-- last chunk of an ordinary Import only drops the rows it has finished with, so what a stopped replace was holding stays
-- until a replace completes or the Admin discards it, and the Import screen says how many are waiting.
--
-- `applied` is 1 once the row has been given to a re-imported Transaction, and `differs` is then 1 if that Transaction's
-- amount is not the one the removed Transaction had (the bank may have numbered a day differently). Both stay until the
-- last chunk so it can say how many were carried over in all, across every chunk of the Import.
--
-- `date`, `amount_cents`, `description` and `category_name` describe the removed Transaction, so a lost Override or Note
-- can be reported by what it was on. `category_name` is the Override's Category as it was named when the row was held.
--
-- `override_category` is not a foreign key: a Category is never deleted, and this table is short-lived and only ever
-- points at one. Not WITHOUT ROWID: the backup pages tables by rowid.
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
  category_name     TEXT,
  PRIMARY KEY (account_id, bank_unique_id)
);
