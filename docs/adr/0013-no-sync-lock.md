# Nothing stops two Syncs running at once

Sync can now be started two ways: the daily cron, and the Admin's "Run a Sync now" on the Settings screen (ticket 27's manual
trigger). Two runs can therefore overlap — the Admin clicking twice, a second browser tab, or a manual run started as the
18:00 UTC cron fires. Fernledger takes no lock and keeps no "a Sync is running" mark. An overlap is allowed to happen, and
costs duplicated work rather than wrong data.

It is safe because every write Sync makes is already repeatable, which it had to be anyway: the cron's window deliberately
overlaps the last run's by 30 days (ADR 0003, spec 49), so Sync writes rows it has already written on every ordinary day.

- **Transactions.** Each row carries Akahu's own ID and is written `ON CONFLICT (akahu_id) DO UPDATE` (spec 48), so a second
  run updates the same row and never adds a second copy. An Account's rows, its Rules and its Transfer pairings go in one
  batch, so they commit together or not at all.
- **Rules.** `applyRulesStatement` sets the same Category for the same rows whichever run reaches them.
- **Transfer pairings.** `PAIR` (`worker/transfers.ts`) only considers rows whose `transfer_of IS NULL`, and collects the rows
  it will pair before it writes any, so a row paired by the first run is not a candidate for the second and nothing is paired
  twice.
- **The last-success mark.** `akahu_synced_at` moves only for an Account that finished. Two runs that both finish write their
  own `now`, so the later-finishing of the two can leave the *earlier* moment on the row. That only widens the next run's
  window, which is the direction Sync is already built to tolerate.
- **The budgets.** Each run is its own Workers invocation with its own 50 subrequests and 50 D1 queries (ADR 0004), and
  `MAX_PAGES` caps the pages of a run, not of a day. Two runs cannot between them breach either per-invocation budget. What
  they can do is spend twice the Akahu page requests and twice the D1 row writes against the daily 100,000, bounded by
  `MAX_PAGES` each.

A lock would buy only those duplicated requests back, and it would cost more than it saves. It needs somewhere to live, so a
table and a migration that can never be dropped (ADR 0009). It needs a staleness window, because a Worker killed mid-run
cannot release it — and that window is the problem: the whole reason the manual trigger exists is that the Admin could not
retry after fixing a bad token without waiting for the next morning. A lock left behind by a crashed run would make them wait
again, for exactly the retry this feature is here to give them. Blocking the Admin's retry is a worse failure than paying for
a page of Transactions twice.

## Consequences

- There is no `sync_run` table, no lock column and no "running" state. `syncAll` is called the same way by the cron and by
  `POST /api/sync/runs`, and neither asks whether the other is going.
- A manual run reports only what it itself did. It cannot say "a Sync is already running", because nothing knows.
- Anything added to Sync later must stay repeatable in the same sense: a write that is not idempotent on `akahu_id`, or a
  counter that Sync increments, contradicts this ADR and needs it revisited.
- The browser does the one bit of narrowing worth having: the button is off while its own request is in flight, so the
  likeliest overlap — an Admin clicking twice — does not happen in the first place.
