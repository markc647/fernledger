-- Data migration progress (ticket 14): where a chunked, resumable job over the rows of a table has got to.
--
-- D1 Free gives an invocation 10 ms of CPU and 50 queries, and a day 100k rows written and 5 million rows read (ADR 0004),
-- so a change to every row of a big table is done in chunks, each its own invocation, and the job's place is kept here so the
-- next invocation (a browser request, or a cron run) carries on from it, however long after. ADR 0009 calls for the same
-- from any large backfill, and any future one uses this table. The first kind of job is re-running Rules over all
-- Transactions (worker/rule-rerun.ts).
--
-- A job is a row. It is never deleted: a finished row is the record of the last run, and the Change Log has the rest.
--   kind          what the job does; one value per kind of job, written by the code that runs it ('rules-rerun')
--   status        'running' until every row up to `end_id` has been done, then 'done'; 'stopped' if the Admin ended it first
--   cursor        the last row ID done. The job walks the table by row ID, so what is above it is still to do
--   end_id        the highest row ID when the job started (or last restarted): where the walk stops. Rows added after
--                 that are not the job's; whatever added them (an Import) did its own part
--   total_rows    the most rows there can be to do: that same highest ID. A row ID is not a count (removed rows leave gaps),
--                 and counting the rows would read every one, so it is an upper bound and "x of up to y" is the honest
--                 way to say it
--   done_rows     how many rows the job has walked since it started (or last restarted)
--   changed_rows  how many of those it had to write (a row whose result was already right is not written)
--   restarts      how many times the job went back to the beginning because what it applies changed while it ran
--   started_by    the Admin's email, who the Change Log entry for the job's end is recorded for if no request is running it
--   usage_day, day_rows_read, day_rows_written
--                 the rows D1 says the job has read and written on one UTC day (`usage_day`, YYYY-MM-DD; D1's allowance
--                 resets at 00:00 UTC). The job pauses itself when the next chunk would pass its own share of the day's
--                 allowance, so it can't use what the rest of the app needs; a new day starts the tally again from nothing
-- Times are UTC, ISO 8601.
CREATE TABLE data_migration_progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (length(kind) > 0),
  status           TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped')),
  cursor           INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  end_id           INTEGER NOT NULL CHECK (end_id >= 0),
  total_rows       INTEGER NOT NULL CHECK (total_rows >= 0),
  done_rows        INTEGER NOT NULL DEFAULT 0 CHECK (done_rows >= 0),
  changed_rows     INTEGER NOT NULL DEFAULT 0 CHECK (changed_rows >= 0),
  restarts         INTEGER NOT NULL DEFAULT 0 CHECK (restarts >= 0),
  started_by       TEXT NOT NULL,
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at      TEXT,
  usage_day        TEXT,
  day_rows_read    INTEGER NOT NULL DEFAULT 0 CHECK (day_rows_read >= 0),
  day_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (day_rows_written >= 0)
);

-- One job of a kind at a time. Two requests that both try to start one cannot both succeed, whatever the Worker checks first.
CREATE UNIQUE INDEX data_migration_progress_running ON data_migration_progress (kind) WHERE status = 'running';
