-- Data migration progress (ticket 14): where a chunked, resumable job over the Transactions has got to.
--
-- D1 Free gives an invocation 10 ms of CPU and 50 queries, and a day 100k rows written and 5 million rows read (ADR 0004),
-- so a change to every Transaction is done in chunks, each its own invocation, and the job's place is kept here so the
-- next invocation (a browser request, or a cron run) carries on from it, however long after. ADR 0009 calls for the same
-- from any large backfill. The first kind of job is re-running Rules over all history (worker/rule-rerun.ts).
--
-- A job is a row. It is never deleted: a finished row is the record of the last run, and the Change Log has the rest.
--   kind          what the job does; one value per kind of job, written by the code that runs it ('rules-rerun')
--   status        'running' until every Transaction up to `end_id` has been done, then 'done'
--   cursor        the last Transaction ID done. The job walks Transactions by ID, so what is above it is still to do
--   end_id        the highest Transaction ID when the job started (or last restarted): where the walk stops. Transactions
--                 added after that are not the job's; whatever added them (an Import) did its own part
--   total_rows    how many Transactions there were then, for "x of y"
--   done_rows     how many the job has walked since it started (or last restarted)
--   changed_rows  how many of those it had to write (a Transaction whose result was already right is not written)
--   restarts      how many times the job went back to the beginning because what it applies changed while it ran
--   started_by    the Admin's email, who the Change Log entry for the job's end is recorded for if no request is running it
-- Times are UTC, ISO 8601.
CREATE TABLE data_migration_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (length(kind) > 0),
  status       TEXT NOT NULL CHECK (status IN ('running', 'done')),
  cursor       INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  end_id       INTEGER NOT NULL CHECK (end_id >= 0),
  total_rows   INTEGER NOT NULL CHECK (total_rows >= 0),
  done_rows    INTEGER NOT NULL DEFAULT 0 CHECK (done_rows >= 0),
  changed_rows INTEGER NOT NULL DEFAULT 0 CHECK (changed_rows >= 0),
  restarts     INTEGER NOT NULL DEFAULT 0 CHECK (restarts >= 0),
  started_by   TEXT NOT NULL,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at  TEXT
);

-- One job of a kind at a time. Two requests that both try to start one cannot both succeed, whatever the Worker checks first.
CREATE UNIQUE INDEX data_migration_progress_running ON data_migration_progress (kind) WHERE status = 'running';
