// When Akahu last synced an Account (`accounts.akahu_synced_at`, an instant in UTC like 2026-10-16T01:00:00.000Z, null until Sync has reached it) and whether that is recent
// enough to call the Account Synced. Akahu Sync will write the column; the Summary and the Dashboard read it (GET /api/balances) for their Sync column, which is shown only when
// Akahu Sync is set up (ADR 0008). It is worked out here, on the Worker's clock, so the answer does not depend on the clock of whatever device is looking.

/** An Account is Synced when Sync reached it within this long of now. */
export const SYNCED_WITHIN_MS = 24 * 60 * 60 * 1000

// An instant in UTC, as `Date.prototype.toISOString` writes it (milliseconds optional). A date alone, or a time with no zone or another zone, is not what Sync writes, so it is
// not taken to be a Sync: a column that holds something else fails to Not Synced, which can be seen, rather than to Synced.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/** Whether `syncedAt` is no more than 24 hours before `now` (exactly 24 hours counts) and not after it. Null, a value that is not an instant, and a time in the future are not. */
export function syncedInLast24Hours(syncedAt: string | null, now: Date): boolean {
  if (syncedAt === null || !INSTANT.test(syncedAt)) return false
  const age = now.getTime() - Date.parse(syncedAt)
  return age >= 0 && age <= SYNCED_WITHIN_MS // an invalid date (month 13) is NaN, and so is neither
}
