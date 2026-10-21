import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { AKAHU_SYNC, requireFeature } from './features'
import { syncAll } from './sync'
import { nothing, validate } from './validate'

// "Run a Sync now": the Admin starts the daily pull from Akahu without waiting for tomorrow's cron (worker/sync.ts). It is the
// same call the cron makes, with `now` being this moment instead of the cron's scheduled time, so a manual run is one Workers
// invocation with the same 50 subrequests, 50 D1 queries (MAX_QUERIES) and MAX_PAGES as any other (ADR 0004). Nothing here loops or retries.
//
// A write, so app.ts's own guard has already required the Admin, the matching Origin and a JSON content type: a Member is
// refused there, before this file is reached, and so before the feature check. Then the feature check, so a Deployer who has
// not added the Akahu tokens gets "Not set up" and no call goes out (worker/akahu-route.ts and worker/d1-usage-route.ts do the
// same, for the same reasons).
//
// Two Syncs can overlap — this route and the cron, or two clicks — and nothing stops them. Every write Sync makes is repeatable,
// which the overlapping 30-day window already required, and a lock would block the retry this route exists to give:
// [ADR 0013](../docs/adr/0013-no-sync-lock.md) has the whole argument.
//
// No Change Log entry: Sync writes none (worker/sync.ts), and starting one is not a change to the ledger the Admin made by hand.
export const sync = new Hono<AppEnv>()
  .use(requireFeature(AKAHU_SYNC))
  // The run's whole outcome, per Account: how many Transactions were written, whether the Account finished, and why it did not.
  // `ran` is false when no Account is linked yet, which is the one other way a Sync does nothing with the tokens set.
  // Nothing to say in the body: the guard wants JSON, so the browser sends `{}` and anything more is refused (worker/validate.ts).
  .post('/runs', validate('json', nothing), async (c) => c.json(await syncAll(c.env, new Date())))
