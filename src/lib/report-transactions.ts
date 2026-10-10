import { isSearchDate } from './date-range'

// The Transaction listing Report's data, put together in the browser from the API's pages (worker/report-transactions.ts).
// A page is read at a time so no request goes past the free plan's CPU budget (ADR 0004); a Report is a few dozen requests at most.

/** The most Transactions the API gives in a page. The Worker keeps its own copy (worker/report-transactions.ts pins the two together in its test). */
export const REPORT_PAGE_SIZE = 500
/**
 * The most Transactions a Report lists, across all its Accounts: twenty pages. Ten thousand is about 27 a day for a year,
 * far more than the Accounts this app is for; past it the Report says it stops, rather than quietly leaving some out.
 */
export const REPORT_ROW_CAP = 10_000

export type ReportRow = {
  id: number
  date: string
  description: string
  amountCents: number
  /** The effective Category's name, or null while Uncategorised. */
  categoryName: string | null
  note: string | null
}

export type ReportPageRequest = { accountId: number; from: string; to: string; after: string | undefined; limit: number }
export type ReportPage = { transactions: ReportRow[]; next: string | null }

/** One Account's Transactions in the range, oldest first, with what came in and went out. Integer cents; money out is negative. */
export type AccountListing = {
  accountId: number
  accountName: string
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
 * exactly the cap's size isn't called capped. A failed page fails the whole Report: an incomplete listing must never look complete.
 */
export async function loadListing({
  accounts,
  from,
  to,
  fetchPage,
  cap = REPORT_ROW_CAP,
}: {
  accounts: { id: number; name: string }[]
  from: string
  to: string
  fetchPage: (request: ReportPageRequest) => Promise<ReportPage>
  cap?: number
}): Promise<Listing> {
  const sections: AccountListing[] = accounts.map(({ id, name }) => ({ accountId: id, accountName: name, rows: [], moneyInCents: 0, moneyOutCents: 0, netCents: 0 }))
  let rowCount = 0
  let capped = false
  find: for (const section of sections) {
    let after: string | undefined
    for (;;) {
      const room = cap - rowCount
      const page = await fetchPage({ accountId: section.accountId, from, to, after, limit: room === 0 ? 1 : Math.min(REPORT_PAGE_SIZE, room) })
      if (room === 0) {
        // The probe: anything it finds is left out. If it finds nothing this Account is done, and the next one is probed in turn.
        capped = page.transactions.length > 0
        if (capped) break find
        break
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
  for (const section of sections) section.netCents = section.moneyInCents + section.moneyOutCents
  return { sections, rowCount, capped }
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
