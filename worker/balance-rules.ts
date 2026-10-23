// The rules of the Balance Check, as pure functions (no database), so each can be tested alone.
//
// A bank balance "counts" every Transaction dated before its date, plus those dated on its date that were saved when
// the balance was recorded. Subtracting what a balance counts from the balance leaves its implied opening balance:
// what the Account held before its first Transaction. Every balance of an Account implies the same opening balance
// if the Transactions are complete, so two balances that imply different ones have a missing or duplicated
// Transaction between their dates. That difference is the Balance Check, and the same opening balance is what
// balance history is computed from (worker/balances.ts).
//
// The bank balance of an Account that is Synced is Akahu's (syncBalance, below): Sync records it after each run that finished,
// and it is checked like any other. It is dated after the Cutover Date by nature, so the rule that uncounts a file's balance
// there (statusOnRecord) is never applied to it.
//
// Pending Transactions are stored apart from Transactions and never counted. A balance that cannot be counted
// (see statusOnRecord) is kept but takes no part.
import type { AccountDetails } from './akahu-details'
import { nzDate } from './nz-time'

export type BalanceStatus = 'matched' | 'differs' | 'alone' | 'after-cutover' | 'file-ends-early'

/** Statuses of balances that the saved Transactions don't reach, so they can't anchor history or be checked. */
export const UNCOUNTED_STATUSES = ['after-cutover', 'file-ends-early'] as const satisfies readonly BalanceStatus[]
const isUncounted = (status: BalanceStatus) => (UNCOUNTED_STATUSES as readonly BalanceStatus[]).includes(status)

/**
 * The status a balance starts with when it is recorded, before it is compared with any other.
 * - On or after the Cutover Date, the Account's Transactions come from Sync, so a file's balance dated then is
 *   ahead of the Transactions an Import keeps ('after-cutover'). Sync's own Balance Check covers those days.
 * - A file that ends before its balance's date has no Transactions for the days in between ('file-ends-early').
 * Dates are `YYYY-MM-DD`, which compare correctly as text.
 */
export function statusOnRecord(balance: { asOfDate: string; fileTo: string; cutoverDate: string | null }): 'alone' | 'after-cutover' | 'file-ends-early' {
  if (balance.cutoverDate !== null && balance.asOfDate >= balance.cutoverDate) return 'after-cutover'
  if (balance.fileTo < balance.asOfDate) return 'file-ends-early'
  return 'alone'
}

/** How far apart Akahu's `refreshed.balance` and `refreshed.transactions` may be for its balance to be checked (syncBalance). */
export const REFRESH_GAP_MS = 5 * 60_000

export type SyncBalance = { asOfDate: string; bankCents: number }
export type SyncBalanceSkipped = 'no-balance' | 'incomplete' | 'refreshed-apart' | 'currency'

/** What Akahu said of an Account's balance, as Sync stores it (worker/akahu-details.ts). Null where Akahu did not say. */
export type ReportedBalance = Pick<AccountDetails, 'akahuType' | 'akahuBalanceCurrency' | 'akahuBalanceCurrentCents' | 'akahuRefreshedBalanceAt' | 'akahuRefreshedTransactionsAt'>

/**
 * The bank balance to record after a Sync of an Account, or why there is none. Akahu's `balance.current` is the balance when Akahu last
 * read the bank (`refreshed.balance`), and a finished Sync holds every Transaction Akahu had read by `refreshed.transactions`. The two
 * cover the same Transactions only if they are read together, so a balance is recorded only when they are at most REFRESH_GAP_MS apart:
 * - It is dated the NZ day Akahu read the bank, not the day of the Sync, so a stale connection, or a second Sync of the same reading,
 *   records the same balance again and adds no day. Transactions dated that day and saved by the Sync count (`through_transaction_id`).
 * - If Akahu read the two further apart, either could hold a Transaction the other lacks, and a Balance Check would report a difference
 *   that is only the gap between them: nothing is recorded. Akahu reads them seconds apart in one refresh (6 s on the test site), so
 *   the same moment cannot be asked for; a bank posting inside that gap is the risk the allowance takes.
 * - A Sync that did not finish has not read the whole window, so nothing is recorded.
 * - Anything Akahu left out, or a currency that is not NZD (money here is NZD cents), is not a balance to check.
 * - A credit card's balance is what is owed, which Akahu sends as a positive figure. In the ledger a purchase is money out, so the
 *   bank balance is its negative: owing $1,268.41 is -126_841 cents, as the card's Transactions add up to.
 */
export function syncBalance(reported: ReportedBalance, complete: boolean): { balance: SyncBalance } | { skipped: SyncBalanceSkipped } {
  if (reported.akahuBalanceCurrentCents === null || reported.akahuRefreshedBalanceAt === null) return { skipped: 'no-balance' }
  if (reported.akahuBalanceCurrency !== null && reported.akahuBalanceCurrency !== 'NZD') return { skipped: 'currency' }
  if (!complete) return { skipped: 'incomplete' }
  const gap = Math.abs(Date.parse(reported.akahuRefreshedTransactionsAt ?? '') - Date.parse(reported.akahuRefreshedBalanceAt))
  if (!(gap <= REFRESH_GAP_MS)) return { skipped: 'refreshed-apart' }
  const bankCents = reported.akahuType === 'CREDITCARD' ? -reported.akahuBalanceCurrentCents : reported.akahuBalanceCurrentCents
  return { balance: { asOfDate: nzDate(new Date(reported.akahuRefreshedBalanceAt)), bankCents } }
}

export type BalanceRow = {
  asOfDate: string
  bankCents: number
  /** The bank balance minus the sum of the Transactions it counts. */
  openingCents: number
  status: BalanceStatus
}

export type CheckResult = {
  asOfDate: string
  status: BalanceStatus
  /** The date of the earlier balance this one was compared with: the previous counted balance, even if that one also differed. */
  checkedAgainst: string | null
  /** The bank's balance on `asOfDate` as the earlier balance and the Transactions since give it. */
  calculatedCents: number | null
  /** The bank's balance minus the calculated one: positive when the bank holds more than the Transactions say. */
  differenceCents: number | null
}

/**
 * Compares each countable balance with the one before it. The first has nothing before it ('alone'); the others are
 * 'matched' or 'differs'. Balances that can't be counted keep their status and are skipped over.
 */
export function checkBalances(balances: readonly BalanceRow[]): CheckResult[] {
  const sorted = [...balances].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
  let previous: BalanceRow | undefined
  return sorted.map((balance): CheckResult => {
    if (isUncounted(balance.status)) return { asOfDate: balance.asOfDate, status: balance.status, checkedAgainst: null, calculatedCents: null, differenceCents: null }
    const before = previous
    previous = balance
    if (!before) return { asOfDate: balance.asOfDate, status: 'alone', checkedAgainst: null, calculatedCents: null, differenceCents: null }
    // The earlier balance and the Transactions since predict the bank's balance as it minus (opening now - opening then).
    const differenceCents = balance.openingCents - before.openingCents
    return {
      asOfDate: balance.asOfDate,
      status: differenceCents === 0 ? 'matched' : 'differs',
      checkedAgainst: before.asOfDate,
      calculatedCents: balance.bankCents - differenceCents,
      differenceCents,
    }
  })
}

export type ImportOutcome = {
  status: BalanceStatus
  /** The date the checked span ends. */
  asOfDate: string
  /** The date it starts: the date of the previous bank balance it was compared with. Null when nothing was compared. */
  since: string | null
  differenceCents: number | null
}

const outcome = (result: CheckResult): ImportOutcome => ({ status: result.status, asOfDate: result.asOfDate, since: result.checkedAgainst, differenceCents: result.differenceCents })

/**
 * What to tell the Admin after an Import recorded the balance dated `asOfDate`: the check of the span that ends there,
 * or, when it is the Account's oldest balance, the span after it. Null if `asOfDate` has no result.
 */
export function importOutcome(results: readonly CheckResult[], asOfDate: string): ImportOutcome | null {
  const own = results.find((result) => result.asOfDate === asOfDate)
  if (!own) return null
  if (own.status === 'matched' || own.status === 'differs') return outcome(own)
  const next = results.find((result) => result.checkedAgainst === asOfDate)
  return outcome(next ?? own)
}
