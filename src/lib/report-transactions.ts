import { isSearchDate } from './date-range'
import type { TransferSource } from './transfers'

// The Transaction listing Report's data, put together in the browser from the API's pages (worker/report-transactions.ts).
// A page is read at a time (ADR 0004: many small requests, not one big one): about 50 pages for the cap, plus about one request
// per Account for its last part-page or the probe past the cap.

/** The most Transactions the API gives in a page, the largest page of the Transactions list. The Worker keeps its own copy (worker/report-transactions.ts pins the two together in its test). */
export const REPORT_PAGE_SIZE = 200
/**
 * The most Transactions a Report lists, across all its Accounts: fifty pages. Ten thousand is about 27 a day for a year,
 * far more than the Accounts this app is for; past it the Report says it stops, rather than quietly leaving some out.
 */
export const REPORT_ROW_CAP = 10_000

export type ReportRow = {
  id: number
  date: string
  description: string
  amountCents: number
  /** The effective Category's name, or null while Uncategorised or a Transfer. */
  categoryName: string | null
  /** Set while the Transaction is a Transfer, which the listing names instead of a Category. */
  transfer: TransferSource | null
  note: string | null
  /** 'import' for a bank file, which gives a cheque number and nothing else about the payment; 'sync' for Akahu. */
  source: 'import' | 'sync'
  bankReference: string | null
  bankCounterpartyAccount: string | null
  bankCardSuffix: string | null
  bankParticulars: string | null
  bankPaymentCode: string | null
}

/**
 * What the bank said about the payment, as short "Label: value" parts in the order a record wants them: the reference (a cheque
 * number for an Import), the counterparty's account, the card, the particulars and the code. What is missing or blank is left out.
 * The labels are the Transaction details page's.
 */
export function detailsOf(row: ReportRow): string[] {
  const parts: [string, string | null][] = [
    [row.source === 'import' ? 'Cheque number' : 'Reference', row.bankReference],
    ['Counterparty account', row.bankCounterpartyAccount],
    ['Card', row.bankCardSuffix?.trim() ? `Ending ${row.bankCardSuffix.trim()}` : null],
    ['Particulars', row.bankParticulars],
    ['Code', row.bankPaymentCode],
  ]
  return parts.flatMap(([label, value]) => (value?.trim() ? [`${label}: ${value.trim()}`] : []))
}

export type ReportPageRequest = { accountId: number; from: string; to: string; after: string | undefined; limit: number }
export type ReportPage = { transactions: ReportRow[]; next: string | null }

/**
 * How much of an Account's range the Report listed: 'complete' (all of it, even when that is nothing), 'partial' (the cap fell in
 * the middle of it) or 'not-listed' (the Report stopped before it, so nothing is known of what it holds).
 */
export type ListingStatus = 'complete' | 'partial' | 'not-listed'

/** One Account's Transactions in the range, oldest first, with what came in and went out. Integer cents; money out is negative. */
export type AccountListing = {
  accountId: number
  accountName: string
  /** The bank's number for the Account, printed beside its name. */
  accountNumber: string
  status: ListingStatus
  rows: ReportRow[]
  moneyInCents: number
  moneyOutCents: number
  netCents: number
}

export type Listing = {
  sections: AccountListing[]
  rowCount: number
  /** True when the Report stopped at the cap with Transactions left out. */
  capped: boolean
}

/**
 * Reads the range for each Account in turn, a page at a time, until every Transaction is in or the cap is reached. With
 * no room left it asks for one more Transaction only to learn whether any are being left out (`capped`), so a range of
 * exactly the cap's size isn't called capped. The Account where that one more is found is 'partial' if some of it was listed
 * and 'not-listed' if none was; every Account after it is 'not-listed' and is not asked about, so the Report never says an
 * Account has nothing in the range when it simply stopped before reading it. A failed page fails the whole Report: an
 * incomplete listing must never look complete.
 */
export async function loadListing({
  accounts,
  from,
  to,
  fetchPage,
  cap = REPORT_ROW_CAP,
}: {
  accounts: { id: number; name: string; accountNumber: string }[]
  from: string
  to: string
  fetchPage: (request: ReportPageRequest) => Promise<ReportPage>
  cap?: number
}): Promise<Listing> {
  const sections: AccountListing[] = accounts.map(({ id, name, accountNumber }) => ({
    accountId: id,
    accountName: name,
    accountNumber,
    status: 'complete',
    rows: [],
    moneyInCents: 0,
    moneyOutCents: 0,
    netCents: 0,
  }))
  let rowCount = 0
  let stoppedAt = -1 // the index of the Account where the Report found Transactions it had no room for
  find: for (const [index, section] of sections.entries()) {
    let after: string | undefined
    for (;;) {
      const room = cap - rowCount
      const page = await fetchPage({ accountId: section.accountId, from, to, after, limit: room === 0 ? 1 : Math.min(REPORT_PAGE_SIZE, room) })
      if (room === 0) {
        // The probe: anything it finds is left out. If it finds nothing this Account is done, and the next one is probed in turn.
        if (page.transactions.length === 0) break
        stoppedAt = index
        break find
      }
      for (const row of page.transactions) {
        section.rows.push(row)
        if (row.amountCents > 0) section.moneyInCents += row.amountCents
        else section.moneyOutCents += row.amountCents
      }
      rowCount += page.transactions.length
      if (page.next === null) break
      after = page.next
    }
  }
  for (const [index, section] of sections.entries()) {
    section.netCents = section.moneyInCents + section.moneyOutCents
    // A cut-off Account with no rows listed is 'not-listed', not 'partial' (intended): the cap fell at the end of the Account
    // before it, so none of this one was read, and the Report says so rather than "No Transactions in these dates".
    if (stoppedAt >= 0 && index >= stoppedAt) section.status = index === stoppedAt && section.rows.length > 0 ? 'partial' : 'not-listed'
  }
  return { sections, rowCount, capped: stoppedAt >= 0 }
}

/** What a Report's address holds: the Account (all of them when left out) and the dates, both ends included. */
export type ReportSearch = { account?: number; from?: string; to?: string }

const accountId = (value: unknown) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 1 && number <= 999_999_999 ? number : undefined
}

const searchDate = (value: unknown) => (typeof value === 'string' && isSearchDate(value) ? value : undefined)

/** Reads the address's search parameters (already parsed by the router) into a ReportSearch. Anything that isn't valid is left out rather than refused. */
export function parseReportSearch(raw: Record<string, unknown>): ReportSearch {
  const search = { account: accountId(raw.account), from: searchDate(raw.from), to: searchDate(raw.to) }
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined))
}
