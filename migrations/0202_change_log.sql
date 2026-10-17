-- Change Log: every change the Admin makes, who and when, with before and after (visible to all Members).
-- Rows are written in the same D1 batch as the change itself (worker/changelog.ts).
-- `before` and `after` are JSON text, or NULL when there is nothing to show.
CREATE TABLE change_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor   TEXT NOT NULL,
  summary TEXT NOT NULL,
  before  TEXT,
  after   TEXT
);
