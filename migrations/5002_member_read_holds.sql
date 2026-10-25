-- The holds of the Members' daily read limit (ticket #50, worker/member-read-limit.ts): what a Member's dear requests in flight have reserved.
--
--   held        rows held by this Member's requests reserved on this row's day and not yet settled
--   held_count  how many of them: at most MEMBER_MAX_IN_FLIGHT may be in flight at once
--   held_at     when the oldest of them was reserved, ms since the epoch (the Worker's clock). Once it is HOLD_EXPIRY_MS old the holds are
--               taken as spent by requests that never settled (cancelled, say): the next reservation charges them and starts again, and they
--               no longer count as in flight, so a Member can't be locked out by them, however busy
--
-- 5001_member_read_usage.sql's trigger deletes earlier days' rows on a Member's first row of the day. The trigger below keeps a row while
-- its holds are young, against the newest hold anyone has made (the table's own clock), so a request reserved before 00:00 UTC and still in
-- flight after it is counted in the new day's admission, and settles against its own row.
ALTER TABLE member_read_usage ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_read_usage ADD COLUMN held_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_read_usage ADD COLUMN held_at INTEGER;

CREATE TRIGGER member_read_usage_keep_held BEFORE DELETE ON member_read_usage
WHEN OLD.held > 0 AND OLD.held_at >= (SELECT MAX(held_at) FROM member_read_usage) - 60000
BEGIN
  SELECT RAISE(IGNORE);
END;
