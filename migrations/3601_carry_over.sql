-- Carry over (ticket 36): replacing an Account's imported history removes its Import-sourced Transactions, and with
-- them any Override or Note the Admin set. Before the rows go, each one that has an Override (to a Category in use) or
-- a Note is copied here, keyed by the bank's unique ID. Each later chunk of the Import gives the rows it saves the
-- Override and Note held under the same ID (worker/carry-over.ts), and the last chunk empties the Account's rows here.
--
-- Rows are held only while a replace is under way, so the table is normally empty. A replace that stops part way leaves
-- its rows here until the Account's next Import finishes; the Import screen says how many are waiting.
--
-- `applied` is 1 once the row has been given to a re-imported Transaction. It stays until the last chunk so that chunk
-- can say how many were carried over in all, across every chunk of the Import.
--
-- Not WITHOUT ROWID: the backup pages tables by rowid.
CREATE TABLE carry_over (
  account_id        INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  bank_unique_id    TEXT NOT NULL,
  -- A Category that was in use when the row was held; it is checked again before it is given to a Transaction. Not a
  -- foreign key: a Category is never deleted, and this table is short-lived and only ever points at one.
  override_category INTEGER,
  note              TEXT,
  applied           INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  PRIMARY KEY (account_id, bank_unique_id)
);
