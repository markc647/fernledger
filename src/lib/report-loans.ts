import type { LoanPage, LoanRow } from '../generated/api/report-loans' // relative, not '@/': a Worker test imports this file (worker/report-loans.test.ts)
import { formatBalance } from './format'
import { addressId, readUpToCap, searchDate, statusAt, type ListingStatus } from './report-transactions'

// The Loans Report's data, put together in the browser from the API's pages (worker/report-loans.ts), one Loans Category after another, a page at a time
// (ADR 0004), up to a cap, by the same loop as the Transaction listing's (`readUpToCap`). The Worker finds which Transactions are loans; this file only adds them up and
// words the result. Money is integer cents. A Transaction's amount is signed as in every list (money out is negative); what is *owed* is the other way round: it is
// positive while more has gone out than come back, which is a person who owes the Accounts, and negative while more has come in, which is a person the Accounts owe.

/**
 * The most Transactions the API gives in a page of a loan, and the most a Report lists across its loans. Larger pages and a lower cap than the Transaction listing's (200 and
 * 10,000), because every page of a loan re-reads the whole loan (ADR 0004): a family's loan is a page, and the worst Report is a handful. The Worker keeps its own copy of the
 * page size (worker/report-loans.ts); worker/report-loans.test.ts pins the two together.
 */
export const LOANS_PAGE_SIZE = 1000
export const LOANS_ROW_CAP = 5000

/** What is owed once the Transactions in `netCents` (money in less money out) have happened. Written as a subtraction so that nothing owed is 0, never -0. */
export const owedOf = (netCents: number) => 0 - netCents

// A Category is named for its person in the form "Loan – Alice" (the Categories page says so). The dashes people type or paste for it: hyphen, the Unicode hyphens (U+2010,
// U+2011), figure dash (U+2012), en and em dash, horizontal bar and the minus sign (U+2212), and a colon. "Loan Alice", "Loans to Alice" and "Loan from Alice" are read too.
const LOAN_PREFIX = /^loans?(?:\s*[-‐-―−:]\s*|\s+(?:(?:to|from)\s+)?|$)/i

/**
 * The person a Loans Category is named for, to say who owes whom: "Loan – Alice" is Alice's loan, so "Alice owes $300.00 to the Accounts". A name that starts "Loan" or "Loans"
 * and then a dash or colon, or "to" or "from", or just a space, is read that way, and any other name is used as it stands ("Alice" says "Alice owes", and "Alice's car" says
 * "Alice's car owes", which is odd but is what the Admin called it). Null for a name that is only "Loan" or "Loans" (the starter Category, before it is renamed), which
 * names no one: the Report then says the Accounts are owed, or owe, and not a name.
 */
export const loanPerson = (categoryName: string) => categoryName.trim().replace(LOAN_PREFIX, '').trim() || null

/** Who owes whom, in a sentence: "Alice owes $300.00 to the Accounts" when more went out than came in, "Alice is owed $300.00" when more came in, "Alice owes nothing" when they are level. */
export function owedSentence(person: string | null, owedCents: number): string {
  const amount = formatBalance(Math.abs(owedCents))
  if (owedCents === 0) return person ? `${person} owes nothing` : 'Nothing is owed'
  if (owedCents > 0) return person ? `${person} owes ${amount} to the Accounts` : `${amount} is owed to the Accounts`
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
  /** How many Transactions are before the start date, so a loan that was paid off can be told from one that was never used. Zero when there is no start date. */
  openingCount: number
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
 * (`readUpToCap`): the loan where the cap falls is 'partial' if some of it was listed and 'not-listed' if none was, and every loan after it is 'not-listed' and is not asked
 * about, so the Report never says a loan has nothing in the dates when it simply stopped before reading it. A failed page fails the whole Report.
 */
export async function loadLoans({
  loans,
  from,
  to,
  fetchPage,
  cap = LOANS_ROW_CAP,
}: {
  loans: { id: number; name: string }[]
  /** Left out, the Report begins at the first Transaction. */
  from: string | undefined
  to: string
  fetchPage: (request: LoanPageRequest) => Promise<LoanPage>
  cap?: number
}): Promise<Loans> {
  const sections: LoanSection[] = loans.map(({ id, name }) => ({ categoryId: id, name, status: 'complete', openingOwedCents: 0, openingCount: 0, lines: [], moneyInCents: 0, moneyOutCents: 0, owedCents: null }))
  const { rowCount, stoppedAt } = await readUpToCap({
    sections,
    cap,
    pageSize: LOANS_PAGE_SIZE,
    fetchPage: (section, after, limit) => fetchPage({ categoryId: section.categoryId, from, to, after, limit }),
    take: (section, page) => {
      // Only a loan's first page says what was owed before its start date, and the balance goes on from there.
      if (page.opening !== null) {
        section.openingOwedCents = owedOf(page.opening.cents)
        section.openingCount = page.opening.count
      }
      let owed = section.lines.at(-1)?.owedAfterCents ?? section.openingOwedCents
      for (const row of page.transactions) {
        owed += owedOf(row.amountCents)
        section.lines.push({ ...row, owedAfterCents: owed })
        if (row.amountCents > 0) section.moneyInCents += row.amountCents
        else section.moneyOutCents += row.amountCents
      }
      section.owedCents = owed
    },
  })
  for (const [index, section] of sections.entries()) {
    section.status = statusAt(index, stoppedAt, section.lines.length)
    if (section.status !== 'complete') section.owedCents = null
  }
  return { sections, rowCount, capped: stoppedAt >= 0 }
}

/** A loan nothing has happened on: the Report read all of it, and it has no Transaction in the dates or before them. A loan that was paid off is not unused. */
export const isUnused = (section: LoanSection) => section.status === 'complete' && section.lines.length === 0 && section.openingCount === 0

/**
 * What the loans owe added up, for the top of a Report of several: what the Accounts are owed (the loans where more went out than came back) and what they owe (where more came in),
 * each added on its own and never netted, because a person's debt is not paid by another's loan. A loan the cap stopped has no amount, so it is counted in `notWorkedOut` and
 * is in neither total.
 */
export function totalLoans(sections: LoanSection[]) {
  let owedToCents = 0
  let owedByCents = 0
  let notWorkedOut = 0
  for (const section of sections) {
    if (section.owedCents === null) notWorkedOut += 1
    else if (section.owedCents > 0) owedToCents += section.owedCents
    else owedByCents -= section.owedCents
  }
  return { owedToCents, owedByCents, notWorkedOut }
}

/** What the Loans Report's address holds: the Loans Category (all of them when left out) and the dates, both ends included. A start date is optional. */
export type LoansSearch = { category?: number; from?: string; to?: string }

/** Reads the address's search parameters (already parsed by the router) into a LoansSearch: what is blank or a date that is not valid is `undefined`, and a Category that is named but not valid is one that does not exist (see `parseReportSearch`). */
export function parseLoansSearch(raw: Record<string, unknown>): LoansSearch {
  return { category: addressId(raw.category), from: searchDate(raw.from), to: searchDate(raw.to) }
}
