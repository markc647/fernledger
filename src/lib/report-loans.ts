import type { LoanPage, LoanRow } from '@/generated/api/report-loans'
import { formatBalance } from './format'
import { REPORT_PAGE_SIZE, REPORT_ROW_CAP, searchDate, searchId, type ListingStatus } from './report-transactions'

// The Loans Report's data, put together in the browser from the API's pages (worker/report-loans.ts), one Loans Category after another, a page at a time
// (ADR 0004), up to the Transaction listing's cap. The Worker finds which Transactions are loans; this file only adds them up and words the result.
// Money is integer cents. A Transaction's amount is signed as in every list (money out is negative); what is *owed* is the other way round: it is positive
// while more has gone out than come back, which is a person who owes the Accounts, and negative while more has come in, which is a person the Accounts owe.

/** What is owed once the Transactions in `netCents` (money in less money out) have happened. Written as a subtraction so that nothing owed is 0, never -0. */
export const owedOf = (netCents: number) => 0 - netCents

/**
 * The person a Loans Category is named for, to say who owes whom: "Loan – Alice" is Alice's loan, so "Alice owes $300.00". A name that starts "Loan" or "Loans" and a
 * dash or colon is read that way, and any other name is used as it stands, so a Category the Admin called "Alice" says "Alice owes". Null for a name that is only "Loan" or
 * "Loans" (the starter Category, before it is renamed), which names no one: the Report then says the Accounts are owed, or owe, and not a name.
 */
export const loanPerson = (categoryName: string) => categoryName.trim().replace(/^loans?\s*(?:[-–—:]\s*|$)/i, '').trim() || null

/** Who owes whom, in a sentence: "Alice owes $300.00" when more went out than came in, "Alice is owed $300.00" when more came in, "Alice owes nothing" when they are level. */
export function owedSentence(person: string | null, owedCents: number): string {
  const amount = formatBalance(Math.abs(owedCents))
  if (owedCents === 0) return person ? `${person} owes nothing` : 'Nothing is owed'
  if (owedCents > 0) return person ? `${person} owes ${amount}` : `${amount} is owed to the Accounts`
  return person ? `${person} is owed ${amount}` : `${amount} is owed by the Accounts`
}

/** The same without the amount, to sit under it in a table: "Alice owes", "Alice is owed", "Nothing owed". */
export function owedWords(person: string | null, owedCents: number): string {
  if (owedCents === 0) return 'Nothing owed'
  if (owedCents > 0) return person ? `${person} owes` : 'Owed to the Accounts'
  return person ? `${person} is owed` : 'Owed by the Accounts'
}

/** A Transaction of a loan with what is owed after it. */
export type LoanLine = LoanRow & { owedAfterCents: number }

/** One Loans Category: its Transactions in the dates, oldest first, with what is owed before them, after each and at the end. */
export type LoanSection = {
  categoryId: number
  name: string
  /** How much of the loan the Report listed: 'complete', 'partial' (the cap fell in the middle of it) or 'not-listed' (the Report stopped before it). */
  status: ListingStatus
  /** What was owed before the start date, from every Transaction before it. Zero when there is no start date, or when the loan was not listed. */
  openingOwedCents: number
  lines: LoanLine[]
  /** What came in and went out among the lines. Money out is negative. */
  moneyInCents: number
  moneyOutCents: number
  /** What is owed at the end of the dates. Null unless the whole loan was listed: a partial figure would read as the amount owed. */
  owedCents: number | null
}

export type Loans = { sections: LoanSection[]; rowCount: number; capped: boolean }

export type LoanPageRequest = { categoryId: number; from: string | undefined; to: string; after: string | undefined; limit: number }

/**
 * Reads each of `loans` in turn, a page at a time, until every Transaction is in or the cap is reached, and adds each up. It stops as the Transaction listing does
 * (`loadListing`): with no room left it asks for one more Transaction only to learn whether any are being left out (`capped`), so a loan of exactly the cap's size is
 * not called capped; the loan where one is found is 'partial' if some of it was listed and 'not-listed' if none was; every loan after it is 'not-listed' and is not
 * asked about, so the Report never says a loan has nothing in the dates when it simply stopped before reading it. A failed page fails the whole Report.
 */
export async function loadLoans({
  loans,
  from,
  to,
  fetchPage,
  cap = REPORT_ROW_CAP,
}: {
  loans: { id: number; name: string }[]
  /** Left out, the Report begins at the first Transaction. */
  from: string | undefined
  to: string
  fetchPage: (request: LoanPageRequest) => Promise<LoanPage>
  cap?: number
}): Promise<Loans> {
  const sections: LoanSection[] = loans.map(({ id, name }) => ({ categoryId: id, name, status: 'complete', openingOwedCents: 0, lines: [], moneyInCents: 0, moneyOutCents: 0, owedCents: null }))
  let rowCount = 0
  let stoppedAt = -1 // the index of the loan where the Report found Transactions it had no room for
  find: for (const [index, section] of sections.entries()) {
    let owed = 0
    let after: string | undefined
    for (;;) {
      const room = cap - rowCount
      const page = await fetchPage({ categoryId: section.categoryId, from, to, after, limit: room === 0 ? 1 : Math.min(REPORT_PAGE_SIZE, room) })
      if (room === 0) {
        // The probe: anything it finds is left out. If it finds nothing this loan is done, and the next one is probed in turn.
        if (page.transactions.length === 0) break
        stoppedAt = index
        break find
      }
      // Only a loan's first page says what was owed before its start date.
      if (page.openingCents !== null) {
        section.openingOwedCents = owedOf(page.openingCents)
        owed = section.openingOwedCents
      }
      for (const row of page.transactions) {
        owed += owedOf(row.amountCents)
        section.lines.push({ ...row, owedAfterCents: owed })
        if (row.amountCents > 0) section.moneyInCents += row.amountCents
        else section.moneyOutCents += row.amountCents
      }
      rowCount += page.transactions.length
      section.owedCents = owed
      if (page.next === null) break
      after = page.next
    }
  }
  for (const [index, section] of sections.entries()) {
    // A cut-off loan with no lines listed is 'not-listed', not 'partial' (intended): the cap fell at the end of the loan before it, so none of this one was read.
    if (stoppedAt >= 0 && index >= stoppedAt) {
      section.status = index === stoppedAt && section.lines.length > 0 ? 'partial' : 'not-listed'
      section.owedCents = null
    }
  }
  return { sections, rowCount, capped: stoppedAt >= 0 }
}

/** What the Loans Report's address holds: the Loans Category (all of them when left out) and the dates, both ends included. A start date is optional. */
export type LoansSearch = { category?: number; from?: string; to?: string }

/** Reads the address's search parameters (already parsed by the router) into a LoansSearch. Anything that isn't valid is left out rather than refused. */
export function parseLoansSearch(raw: Record<string, unknown>): LoansSearch {
  const search = { category: searchId(raw.category), from: searchDate(raw.from), to: searchDate(raw.to) }
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined))
}
