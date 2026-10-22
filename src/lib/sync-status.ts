// The Sync status: how current the bank data is, and what is wrong with it when something is (ticket 29, spec 57, 58, 59, 60, 32).
//
// It reads the linked Accounts as the Accounts list already gives them (worker/accounts.ts), so it asks for nothing of its own:
// when Sync last finished each Account, why the last Sync of it did not finish, and since when Akahu has stopped listing it.
// It sits above the Balances table on the Summary and the Dashboard, which both Members and the Admin read.
//
// A Member sees the state and the cause; only the Admin is told what to do about it (spec 60), because reconnecting a bank in
// Akahu and setting the tokens are the Admin's alone. Nothing here promises a retry: Sync runs once a day and when the Admin
// asks for it, and nothing retries behind them (ADR 0013, and part 1 of this ticket dropped the retry cron).
import { formatDateAtTime } from './format'

/** How stale the data may be before the status turns red (spec 58). */
export const STALE_DAYS = 2

/** The part of an Account the status reads. The Accounts list gives all of it (src/routes/accounts.tsx has the whole row). */
export type SyncAccount = {
  name: string
  akahuAccountId: string | null
  akahuSyncedAt: string | null
  akahuMissingSince: string | null
  akahuLastFailure: string | null
  akahuConnectionName: string | null
}

export type SyncStatus = {
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  /** How current the data is, which is the line everyone reads. */
  text: string
  /** What is wrong and why, when something is: a Member reads this too. */
  cause?: string
  /** What to do about it. The Admin only (spec 60). */
  action?: string
}

/** The bank the Account's Transactions come through, as Akahu names it, or the Account's own name when Akahu has not said. */
const bank = (account: SyncAccount) => account.akahuConnectionName ?? account.name

/** Whole days between two instants, rounded down. */
const daysBetween = (from: string, to: Date) => Math.floor((to.getTime() - Date.parse(from)) / 86_400_000)

/**
 * The status of the linked Accounts as a whole, or null when none is linked to Akahu: an app running on Imports alone has no
 * Sync to have a status (ADR 0008), and a card that says so would be noise on every page that carries it.
 *
 * The worst Account decides it, and the oldest successful Sync is what "last updated" says: a status may be behind what one
 * Account managed, never ahead of what the slowest did.
 */
export function syncStatus(accounts: SyncAccount[], now: Date, role: 'admin' | 'member'): SyncStatus | null {
  // `?? null` because an answer from before these fields existed, or one a test wrote by hand, leaves them undefined, and an
  // undefined `akahuMissingSince` must not read as a broken Link.
  const linked = accounts
    .filter((account) => (account.akahuAccountId ?? null) !== null)
    .map((account) => ({
      ...account,
      akahuSyncedAt: account.akahuSyncedAt ?? null,
      akahuMissingSince: account.akahuMissingSince ?? null,
      akahuLastFailure: account.akahuLastFailure ?? null,
      akahuConnectionName: account.akahuConnectionName ?? null,
    }))
  if (linked.length === 0) return null
  const admin = role === 'admin'

  // A broken Link first: nothing else about the Account can come right until it is re-linked (spec 32).
  const broken = linked.filter((account) => account.akahuMissingSince !== null)
  const failed = linked.filter((account) => account.akahuLastFailure !== null)
  const synced = linked.map((account) => account.akahuSyncedAt)
  const never = synced.some((at) => at === null)
  const oldest = never ? null : synced.filter((at): at is string => at !== null).sort()[0]!
  const staleDays = oldest === null ? null : daysBetween(oldest, now)
  const stale = staleDays !== null && staleDays >= STALE_DAYS

  const text =
    oldest === null
      ? linked.length === 1
        ? 'Waiting for the first Sync of this Account.'
        : 'Waiting for the first Sync of some of these Accounts.'
      : `Bank data last updated ${formatDateAtTime(new Date(Date.parse(oldest)))}.`

  if (broken.length > 0) {
    const names = broken.map(bank)
    return {
      tone: 'danger',
      text,
      cause: `${list(names)} ${broken.length === 1 ? 'needs' : 'need'} reconnecting in Akahu: Akahu has stopped listing ${broken.length === 1 ? 'that account' : 'those accounts'}. No Transaction has been removed.`,
      ...(admin ? { action: `Reconnect ${broken.length === 1 ? 'it' : 'them'} in Akahu, then link the Account again on the Accounts screen.` } : {}),
    }
  }

  if (failed.length > 0) {
    // The worst cause of the ones that failed: a token Akahu refuses stops every Account, where one timeout stops one.
    const refused = failed.find((account) => account.akahuLastFailure === 'refused')
    const unreadable = failed.find((account) => account.akahuLastFailure === 'unreadable')
    if (refused !== undefined) {
      return {
        tone: 'danger',
        text,
        cause: 'Akahu token invalid: Akahu refused the tokens, so nothing could be read.',
        ...(admin ? { action: 'Check both tokens in Akahu, set them again in Settings, then run a Sync.' } : {}),
      }
    }
    if (unreadable !== undefined) {
      return {
        tone: 'danger',
        text,
        cause: `Akahu answered, but not with Transactions, for ${list(failed.map(bank))}.`,
        ...(admin ? { action: "Run a Sync; if it keeps happening it is Akahu's end." } : {}),
      }
    }
    return {
      tone: stale ? 'danger' : 'warning',
      text,
      cause: `Akahu unavailable for ${list(failed.map(bank))}: it could not be reached, or took too long.`,
      // No retry runs by itself: the next daily Sync tries again, and the Admin can ask for one now.
      ...(admin ? { action: 'The next Sync will try again. Run a Sync now if you would rather not wait.' } : {}),
    }
  }

  if (oldest === null) return { tone: 'neutral', text }
  if (stale) {
    return {
      tone: 'danger',
      text,
      cause: `No Sync has finished for ${staleDays} days, so this may be out of date.`,
      ...(admin ? { action: 'Run a Sync. If it fails, the reason is shown with it.' } : {}),
    }
  }
  return { tone: 'success', text }
}

/** "ASB", "ASB and Kiwibank", "ASB, Kiwibank and BNZ": the banks named in the order they were given, without repeats. */
const list = (names: string[]) => {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? ''
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`
}
