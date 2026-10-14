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
 * How much of section `index` was listed, given where `readUpToCap` stopped (`stoppedAt`, -1 when it did not) and how many of its rows it took: sections before the stop
 * are 'complete', the one it stopped in is 'partial' if some of it was listed and 'not-listed' if none was, and every section after it is 'not-listed'. A cut-off section with
 * no rows listed is 'not-listed', not 'partial' (intended): the cap fell at the end of the section before it, so none of this one was read, and the Report says so rather than
 * "No Transactions in these dates".
 */
export const statusAt = (index: number, stoppedAt: number, listed: number): ListingStatus =>
  stoppedAt < 0 || index < stoppedAt ? 'complete' : index === stoppedAt && listed > 0 ? 'partial' : 'not-listed'

/**
 * What every Report that lists Transactions section by section (the Transaction listing's Accounts, the Loans Report's Loans Categories) does to stay within the cap and
 * ADR 0004: reads each section in turn, a page at a time, until every Transaction is in or `cap` Transactions are. With no room left it asks for one more Transaction only to
 * learn whether any are being left out, so a range of exactly the cap's size isn't called capped, and goes on to the next section if this one has none. The section where that
 * one more is found is where it stopped (`stoppedAt`, its index; -1 if it never was), and no section after it is asked about, so a Report never says a section has nothing in
 * its range when it simply stopped before reading it (`statusAt`). `take` adds a page's rows to its section, and is not called for the one-row probe that finds a row (that row is
 * left out), but is for a probe that finds none, since that page is the whole of the section and adds nothing to the count: a section with no rows still has what its first page says
 * about it. A failed page fails the whole Report: an incomplete listing must never look complete.
 */
export async function readUpToCap<Section, Page extends { transactions: unknown[]; next: string | null }>({
  sections,
  cap,
  pageSize,
  fetchPage,
  take,
}: {
  sections: Section[]
  cap: number
  /** The most rows to ask for at once. */
  pageSize: number
  fetchPage: (section: Section, after: string | undefined, limit: number) => Promise<Page>
  take: (section: Section, page: Page) => void
}): Promise<{ rowCount: number; stoppedAt: number }> {
  let rowCount = 0
  let stoppedAt = -1
  find: for (const [index, section] of sections.entries()) {
    let after: string | undefined
    for (;;) {
      const room = cap - rowCount
      const page = await fetchPage(section, after, room === 0 ? 1 : Math.min(pageSize, room))
      if (room === 0) {
        // The probe: anything it finds is left out. If it finds nothing this section is done, and the next one is probed in turn. What it did find out about the section
        // (a loan's opening balance, which its first page carries) is kept, so a section with nothing in the dates is not taken for one with nothing at all.
        if (page.transactions.length === 0) {
          take(section, page)
          break
        }
        stoppedAt = index
        break find
      }
      take(section, page)
      rowCount += page.transactions.length
      if (page.next === null) break
      after = page.next
    }
  }
  return { rowCount, stoppedAt }
}

/**
 * Reads the range for each Account in turn, a page at a time, until every Transaction is in or the cap is reached (`readUpToCap`, which says how it stops). The Account where
 * the cap falls is 'partial' if some of it was listed and 'not-listed' if none was; every Account after it is 'not-listed'.
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
  const { rowCount, stoppedAt } = await readUpToCap({
    sections,
    cap,
    pageSize: REPORT_PAGE_SIZE,
    fetchPage: (section, after, limit) => fetchPage({ accountId: section.accountId, from, to, after, limit }),
    take: (section, page) => {
      for (const row of page.transactions) {
        section.rows.push(row)
        if (row.amountCents > 0) section.moneyInCents += row.amountCents
        else section.moneyOutCents += row.amountCents
      }
    },
  })
  for (const [index, section] of sections.entries()) {
    section.netCents = section.moneyInCents + section.moneyOutCents
    section.status = statusAt(index, stoppedAt, section.rows.length)
  }
  return { sections, rowCount, capped: stoppedAt >= 0 }
}

/** What a Report's address holds: the Account (all of them when left out) and the dates, both ends included. */
export type ReportSearch = { account?: number; from?: string; to?: string }

/** An ID in an address (an Account's, or the Loans Report's Category): a whole number from 1 to 999,999,999, or nothing. */
export const searchId = (value: unknown) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 1 && number <= 999_999_999 ? number : undefined
}

/**
 * The ID an address names (an Account's, or a Loans Category's), for what is named and not what is valid: nothing for a blank one (`account=`, which an earlier form sent for
 * every Account), and 0, an ID nothing has, for one that is named but is not an ID (`abc`, `-1`, too many digits). The page then says there is no such Account, and does not
 * quietly widen to every Account, which is not what the address asked for.
 */
export const addressId = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : (searchId(value) ?? 0))

/** A date in an address: a real date within the years the API accepts, or nothing. */
export const searchDate = (value: unknown) => (typeof value === 'string' && isSearchDate(value) ? value : undefined)

/**
 * Reads the address's search parameters (already parsed by the router) into a ReportSearch. A blank one is left out, and so is a date that isn't valid (the page then asks for
 * the dates); an Account that is named but not valid is one that does not exist (`addressId`). Each is `undefined` when left out, and not missing, because the router lays what a
 * route validates over the address's own search, so a missing key would leave the address's text in its place.
 */
export function parseReportSearch(raw: Record<string, unknown>): ReportSearch {
  return { account: addressId(raw.account), from: searchDate(raw.from), to: searchDate(raw.to) }
}
