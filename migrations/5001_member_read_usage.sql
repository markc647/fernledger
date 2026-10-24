-- The Members' share of D1 Free's daily rows read (ticket #50, worker/member-read-limit.ts): one row for each Member charged today (UTC).
--
--   member_key  SHA-256 of the UTC day and the Member's email, so the table holds no email address and a Member's key changes every day
--   usage_day   the UTC day, YYYY-MM-DD, as D1 counts a day
--   rows_read   what that Member's requests were charged that day: what each read, or for a small read 1,000 by chance (worker/member-read-limit.ts)
--
-- The first charge of a day for a Member inserts its row, and the trigger then deletes the rows of earlier days, so the table holds about a
-- day and a charge stays one D1 query (each counts towards the 50 of an invocation; ADR 0004). Earlier, not other: a request that began
-- before 00:00 UTC and is charged after it inserts yesterday's row, which must not delete today's.
CREATE TABLE member_read_usage (
  member_key TEXT PRIMARY KEY,
  usage_day  TEXT NOT NULL,
  rows_read  INTEGER NOT NULL CHECK (rows_read >= 0)
);

CREATE TRIGGER member_read_usage_one_day AFTER INSERT ON member_read_usage
BEGIN
  DELETE FROM member_read_usage WHERE usage_day < NEW.usage_day;
END;
