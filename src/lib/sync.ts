// How the Admin's "Run a Sync now" reads out what a Sync did (src/components/sync-now.tsx, worker/sync-route.ts).
//
// Every reason is named with a cause and something to do about it, because the Admin asks for a manual run exactly when they
// are trying to find out why Sync isn't working. Akahu's own error text is never shown: it can echo a token (worker/akahu.ts),
// so the Worker sends one of four fixed words and the sentences for them are here. The Sync status banner a Member sees is
// ticket 29 (#30) and has its own wording.
import type { SyncFailure } from '@/generated/api/sync'

/** One Account's part of a run, as `POST /api/sync/runs` reports it (worker/sync.ts: AccountOutcome). */
export type AccountOutcome = {
  accountId: number
  written: number
  /** Transactions Akahu no longer returns, removed from the window (spec 49). */
  removed: number
  complete: boolean
  /** Why it did not finish, as the Worker names it: the one type, so a cause added there is a case missing here (worker/sync.ts). */
  failure?: SyncFailure
}

/**
 * A whole run (worker/sync.ts: SyncOutcome). `ran` is false when no Account is linked to Akahu, so there was nothing to do.
 * `pending` is how many Pending Transactions it wrote, or null when Akahu could not be asked and what was held was kept.
 */
export type SyncRunOutcome = { ran: boolean; success: boolean; pending: number | null; accounts: AccountOutcome[] }

export type Tone = 'success' | 'warning' | 'danger' | 'neutral'

const count = (n: number) => `${n.toLocaleString('en-NZ')} ${n === 1 ? 'Transaction' : 'Transactions'}`

export const totalWritten = (outcome: SyncRunOutcome) => outcome.accounts.reduce((total, account) => total + account.written, 0)

/**
 * The one line that says how the run went, read out to the Admin as soon as it answers. "Nothing was written" is a success:
 * an ordinary Sync on a quiet day finds nothing new, and saying "0 Transactions" would read as a failure.
 */
export function runSummary(outcome: SyncRunOutcome): { tone: Tone; text: string } {
  if (!outcome.ran) return { tone: 'neutral', text: 'No Account is linked to Akahu, so there was nothing to sync.' }
  const written = totalWritten(outcome)
  if (outcome.success) {
    return { tone: 'success', text: written === 0 ? 'Sync finished. There was nothing new to bring in.' : `Sync finished and brought in ${count(written)}.` }
  }
  const whole = outcome.accounts.every((account) => !account.complete)
  return {
    tone: whole ? 'danger' : 'warning',
    text: written === 0 ? 'Sync did not finish, and nothing was brought in. Each Account is below.' : `Sync did not finish. It brought in ${count(written)}; each Account is below.`,
  }
}

/** What happened to one Account, and what the Admin can do about it. */
export function accountNote(account: AccountOutcome): { tone: Tone; text: string } {
  switch (account.failure) {
    case 'refused':
      return { tone: 'danger', text: 'Akahu refused the tokens. Check them in Akahu, set them again, then run a Sync.' }
    case 'unreachable':
      return { tone: 'warning', text: 'Akahu could not be reached, or took too long. Nothing was brought in. Try again in a few minutes.' }
    case 'unreadable':
      return { tone: 'danger', text: "Akahu answered, but not with Transactions. Nothing was brought in. Try again, and if it keeps happening it's Akahu's end." }
    case 'no-window':
      return { tone: 'warning', text: 'This Account has imported Transactions but no Cutover Date, so Sync left it alone. Set its Cutover Date above, then run a Sync.' }
    // Not a fault, and not the Admin's to fix: a Sync spends only part of what one invocation may ask of the database, so an
    // Account it did not reach waits. It is first in the next run, so saying "run a Sync" is honest here where it is not for
    // the page cap below.
    case 'no-budget':
      return { tone: 'neutral', text: 'Sync ran out of its share of the database for this run before reaching this Account. It is first next time; run a Sync again to do it now.' }
    // A long gap is read MAX_WINDOW_DAYS a run (worker/sync.ts) and each run gets further, so here, unlike the page cap below,
    // running again is the fix.
    case 'catching-up':
      return { tone: 'neutral', text: `Brought in ${count(account.written)} of a long gap, two months at a time. There is more: run a Sync again to carry on.` }
    // Akahu answered the account list and did not name this Account, so nothing it said about it can be trusted: the Transactions
    // held are kept as they are, nothing was withdrawn, and the Account keeps its old last-success mark (spec 32).
    case 'link-broken':
      return {
        tone: 'danger',
        text: 'Akahu has stopped listing this Account, so its Account Link is broken. No Transaction was removed. Reconnect the bank in Akahu, then link the Account again in Settings.',
      }
    default:
      // The page cap: MAX_PAGES is the most pages one Sync may ask for over all its Accounts (worker/akahu.ts), so running again
      // asks for the same window again and gets no further. Don't offer that as a fix.
      if (!account.complete) return { tone: 'warning', text: `Brought in ${count(account.written)} and stopped at the most Akahu pages one Sync may ask for, so not everything was read.` }
      if (account.removed > 0) {
        // The bank withdrew a Transaction and usually re-issued it with a new ID, so this is the ledger catching up, not a loss.
        const removed = `${account.removed === 1 ? '1 Transaction the bank has withdrawn was' : `${account.removed} Transactions the bank has withdrawn were`} removed.`
        return { tone: 'success', text: account.written === 0 ? `Finished. ${removed}` : `Finished and brought in ${count(account.written)}. ${removed}` }
      }
      return { tone: 'success', text: account.written === 0 ? 'Finished. Nothing new to bring in.' : `Finished and brought in ${count(account.written)}.` }
  }
}
