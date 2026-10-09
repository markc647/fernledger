// The rules of the Balance Check, as pure functions (no database), so each can be tested alone.
//
// A bank balance "counts" every Transaction dated before its date, plus those dated on its date that were saved when
// the balance was recorded. Subtracting what a balance counts from the balance leaves its implied opening balance:
// what the Account held before its first Transaction. Every balance of an Account implies the same opening balance
// if the Transactions are complete, so two balances that imply different ones have a missing or duplicated
// Transaction between their dates. That difference is the Balance Check, and the same opening balance is what
// balance history is computed from (worker/balances.ts).
//
// Pending Transactions are stored apart from Transactions and never counted. A balance that cannot be counted
// (see statusOnRecord) is kept but takes no part.

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
  /** The date of the earlier balance this one was compared with: the last date the bank and the Transactions agreed. */
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
  /** The date it starts: when the bank and the Transactions last agreed. Null when nothing was compared. */
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
