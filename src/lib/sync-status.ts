// The Sync status: how current the bank data is, and what is wrong with it when something is (ticket 29, spec 57, 58, 59, 60, 32).
//
// It reads the linked Accounts as the Accounts list already gives them (worker/accounts.ts), so it asks for nothing of its own:
// when Sync last finished each Account, why the last Sync of it did not finish, and since when Akahu has stopped listing it.
// It sits above the Balances table on the Summary and the Dashboard, which both Members and the Admin read.
//
// A Member sees the state and the cause; only the Admin is told what to do about it (spec 60), because reconnecting a bank in
// Akahu, importing a file and setting the tokens are the Admin's alone. Nothing here promises a retry: Sync runs once a day and
// when the Admin asks for it, and nothing retries behind them (ADR 0013, and part 1 of this ticket dropped the retry cron).
import type { SyncFailure } from '@/generated/api/sync'
import { formatDateAtTime, isMoment } from './format'

/** How stale the data may be before the status turns red (spec 58). */
export const STALE_DAYS = 2

/** The part of an Account the status reads. The Accounts list gives all of it (src/routes/accounts.tsx has the whole row). */
export type SyncAccount = {
  name: string
  akahuAccountId: string | null
  akahuSyncedAt: string | null
  akahuMissingSince: string | null
  /** Why the last Sync of it did not finish, as the Worker names it (worker/sync.ts: SyncFailure). */
  akahuLastFailure: SyncFailure | null
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

/** "ASB", "ASB and Kiwibank", "ASB, Kiwibank and BNZ": the banks named in the order they were given, without repeats. */
const list = (names: string[]) => {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? ''
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`
}

/**
 * What is wrong, worst first, and what the Admin can do about it (spec 59). The first cause that has an Account decides the
 * status, and the order is how little else can come right until it is fixed: a broken Link cannot be mended by Syncing, a token
 * Akahu refuses stops every Account, an Account with no Cutover Date is waiting on the Admin, and one the run's budget did not
 * reach is waiting on nothing at all.
 *
 * `hard` is a cause that is red even while the data is still current; the rest turn red once it is stale as well.
 */
const CAUSES: { failure: SyncFailure; hard: boolean; cause: (banks: string, many: boolean) => string; action: (many: boolean) => string }[] = [
  {
    failure: 'link-broken',
    hard: true,
    cause: (banks, many) =>
      `${banks} ${many ? 'need' : 'needs'} reconnecting in Akahu: Akahu has stopped listing ${many ? 'those accounts' : 'that account'}. No Transaction has been removed.`,
    action: (many) => `Reconnect ${many ? 'them' : 'it'} in Akahu, then link the ${many ? 'Accounts' : 'Account'} again in Settings.`,
  },
  {
    failure: 'refused',
    hard: true,
    cause: () => 'Akahu token invalid: Akahu refused the tokens, so nothing could be read.',
    action: () => 'Check both tokens in Akahu, set them again in Settings, then run a Sync.',
  },
  {
    failure: 'unreadable',
    hard: true,
    cause: (banks) => `Akahu answered, but not with Transactions, for ${banks}.`,
    action: () => "Run a Sync; if it keeps happening it is Akahu's end.",
  },
  {
    failure: 'unreachable',
    hard: false,
    cause: (banks) => `Akahu unavailable for ${banks}: it could not be reached, or took too long.`,
    // No retry runs by itself: the next daily Sync tries again, and the Admin can ask for one now.
    action: () => 'The next Sync will try again. Run a Sync now if you would rather not wait.',
  },
  {
    failure: 'no-window',
    hard: false,
    cause: (banks, many) => `${banks} ${many ? 'have' : 'has'} no Cutover Date, so Sync leaves ${many ? 'them' : 'it'} alone.`,
    action: (many) => `Import a bank file for ${many ? 'each of them' : 'it'} to set its Cutover Date, then run a Sync.`,
  },
  {
    failure: 'no-budget',
    hard: false,
    cause: (banks, many) => `Sync has not reached ${banks} yet: a run takes four Accounts, and ${many ? 'they come' : 'it comes'} first in the next one.`,
    action: (many) => `The next Sync takes ${many ? 'them' : 'it'} first. Run a Sync now if you would rather not wait.`,
  },
  {
    // A long gap is read MAX_WINDOW_DAYS a run (worker/sync.ts), and each run gets further, so running one is the fix.
    failure: 'catching-up',
    hard: false,
    cause: (banks, many) => `${banks} ${many ? 'are' : 'is'} catching up on a long gap: a Sync reads two months of it at a time.`,
    action: () => 'The next Sync carries on. Run a Sync now to catch up sooner.',
  },
]

/**
 * The status of the linked Accounts as a whole, or null when none is linked to Akahu: an app running on Imports alone has no
 * Sync to have a status (ADR 0008), and a line that said so would be noise on every page that carries it.
 *
 * "Last updated" is the oldest Sync that finished, so it is never more current than the slowest Account. An Account that has
 * never synced does not take that line away from the Accounts that have, and does not hide how stale they are: it adds a clause
 * of its own. Only where no Account has ever synced is there nothing to date.
 */
export function syncStatus(accounts: SyncAccount[], now: Date, role: 'admin' | 'member'): SyncStatus | null {
  // `?? null` because an answer from before these fields existed, or one a test wrote by hand, leaves them undefined, and an
  // undefined `akahuMissingSince` must not read as a broken Link.
  const linked = accounts
    .filter((account) => (account.akahuAccountId ?? null) !== null)
    .map((account) => ({
      ...account,
      // Only an instant that can be shown counts as a Sync that finished: a value that is not one would otherwise date the status.
      akahuSyncedAt: isMoment(account.akahuSyncedAt) ? account.akahuSyncedAt : null,
      akahuMissingSince: account.akahuMissingSince ?? null,
      akahuLastFailure: account.akahuLastFailure ?? null,
      akahuConnectionName: account.akahuConnectionName ?? null,
    }))
  if (linked.length === 0) return null

  const synced = linked.filter((account) => account.akahuSyncedAt !== null)
  const waiting = linked.length - synced.length
  const oldest = synced.map((account) => account.akahuSyncedAt!).sort()[0] ?? null
  const staleDays = oldest === null ? null : daysBetween(oldest, now)
  const stale = staleDays !== null && staleDays >= STALE_DAYS

  const waitingClause = waiting === 0 ? '' : ` ${waiting === 1 ? 'One Account is' : `${waiting} Accounts are`} waiting for a first Sync.`
  const text =
    oldest === null
      ? linked.length === 1
        ? 'Waiting for the first Sync of this Account.'
        : 'Waiting for the first Sync of these Accounts.'
      : `Bank data last updated ${formatDateAtTime(new Date(Date.parse(oldest)))}.${waitingClause}`

  // A broken Link is recorded as the Account's last failure and as the day Akahu first stopped listing it; either says so.
  const failureOf = (account: SyncAccount) => (account.akahuMissingSince !== null ? 'link-broken' : account.akahuLastFailure)
  for (const { failure, hard, cause, action } of CAUSES) {
    const affected = linked.filter((account) => failureOf(account) === failure)
    if (affected.length === 0) continue
    const many = affected.length > 1
    return said({ tone: hard || stale ? 'danger' : 'warning', text, cause: cause(list(affected.map(bank)), many), action: action(many) }, role)
  }

  if (oldest === null) return { tone: 'neutral', text }
  if (stale) {
    return said(
      { tone: 'danger', text, cause: `No Sync has finished for ${staleDays} days, so this may be out of date.`, action: 'Run a Sync. If it fails, the reason is shown with it.' },
      role,
    )
  }
  return { tone: 'success', text }
}

/** The status as the reader is given it: a Member is told the state and the cause, and never what only the Admin can do (spec 60). */
const said = (status: Required<SyncStatus>, role: 'admin' | 'member'): SyncStatus =>
  role === 'admin' ? status : { tone: status.tone, text: status.text, cause: status.cause }
