import { describe, expect, it } from 'vitest'
import { detailsOf, loadListing, parseReportSearch, REPORT_PAGE_SIZE, REPORT_ROW_CAP, type ReportPage, type ReportPageRequest, type ReportRow } from './report-transactions'

let n = 0
const NO_BANK_DETAILS = { source: 'import', bankReference: null, bankCounterpartyAccount: null, bankCardSuffix: null, bankParticulars: null, bankPaymentCode: null } as const
const row = (over: Partial<ReportRow> = {}): ReportRow => {
  n += 1
  return { id: n, date: '2026-10-01', description: `EXAMPLE ${n}`, amountCents: -1000, categoryName: null, note: null, ...NO_BANK_DETAILS, ...over }
}

/** A pretend API: each Account holds `rows`, served `limit` at a time after the place `next` named. Records every request. */
function pretendApi(holdings: Record<number, ReportRow[]>) {
  const requests: ReportPageRequest[] = []
  const fetchPage = async (request: ReportPageRequest): Promise<ReportPage> => {
    requests.push(request)
    const rows = holdings[request.accountId] ?? []
    const start = request.after === undefined ? 0 : Number(request.after)
    const transactions = rows.slice(start, start + request.limit)
    return { transactions, next: start + request.limit < rows.length ? String(start + request.limit) : null }
  }
  return { fetchPage, requests }
}

const range = { from: '2026-10-01', to: '2026-10-31' }
const savings = { id: 1, name: 'Example savings', accountNumber: '99-9999-9999999-99' }
const cheque = { id: 2, name: 'Example cheque', accountNumber: '99-9999-9999999-98' }
const call = { id: 3, name: 'Example call', accountNumber: '99-9999-9999999-97' }
const many = (count: number) => Array.from({ length: count }, () => row())

describe('loadListing', () => {
  it('lists each Account in the order given, with what came in, what went out and the net, in whole cents', async () => {
    const { fetchPage } = pretendApi({
      1: [row({ amountCents: 123456 }), row({ amountCents: -2000 }), row({ amountCents: -1 }), row({ amountCents: 0 })],
      2: [row({ amountCents: -500 })],
    })
    const listing = await loadListing({ accounts: [cheque, savings], ...range, fetchPage })

    expect(listing.sections.map((s) => [s.accountName, s.accountNumber, s.status])).toEqual([
      ['Example cheque', '99-9999-9999999-98', 'complete'],
      ['Example savings', '99-9999-9999999-99', 'complete'],
    ])
    expect(listing.sections[0]).toMatchObject({ moneyInCents: 0, moneyOutCents: -500, netCents: -500 })
    expect(listing.sections[1]).toMatchObject({ moneyInCents: 123456, moneyOutCents: -2001, netCents: 121455 })
    expect(listing.sections[1]!.rows).toHaveLength(4)
    expect(listing).toMatchObject({ rowCount: 5, capped: false })
  })

  it('keeps an Account with nothing in the range, so the Report can say so', async () => {
    const listing = await loadListing({ accounts: [savings, cheque], ...range, fetchPage: pretendApi({ 1: many(2) }).fetchPage })
    expect(listing.sections.map((s) => [s.accountName, s.rows.length, s.status])).toEqual([['Example savings', 2, 'complete'], ['Example cheque', 0, 'complete']])
    expect(listing.sections[1]).toMatchObject({ moneyInCents: 0, moneyOutCents: 0, netCents: 0 })
  })

  it('asks for the range, a page at a time, each continuing where the last stopped', async () => {
    const { fetchPage, requests } = pretendApi({ 1: many(REPORT_PAGE_SIZE + 5) })
    const listing = await loadListing({ accounts: [savings], ...range, fetchPage })

    expect(listing.sections[0]!.rows).toHaveLength(REPORT_PAGE_SIZE + 5)
    expect(requests).toEqual([
      { accountId: 1, ...range, after: undefined, limit: REPORT_PAGE_SIZE },
      { accountId: 1, ...range, after: String(REPORT_PAGE_SIZE), limit: REPORT_PAGE_SIZE },
    ])
  })

  describe('the cap', () => {
    it('lists everything when it is exactly the cap, and does not call that capped', async () => {
      const { fetchPage } = pretendApi({ 1: many(30), 2: many(20) })
      const listing = await loadListing({ accounts: [savings, cheque], ...range, fetchPage, cap: 50 })
      expect(listing).toMatchObject({ rowCount: 50, capped: false })
      expect(listing.sections.map((s) => s.status)).toEqual(['complete', 'complete'])
    })

    it('stops at the cap and says so when an Account has more: that Account is only partly listed', async () => {
      const { fetchPage } = pretendApi({ 1: many(51) })
      const listing = await loadListing({ accounts: [savings], ...range, fetchPage, cap: 50 })
      expect(listing).toMatchObject({ rowCount: 50, capped: true })
      expect(listing.sections[0]).toMatchObject({ status: 'partial' })
      expect(listing.sections[0]!.rows).toHaveLength(50)
    })

    it('does not say an Account has nothing in the range when the Report stopped before it: it was not listed', async () => {
      // The cap falls at the end of the first Account; the second has a Transaction, so the Report is capped and the second not read.
      const { fetchPage } = pretendApi({ 1: many(50), 2: many(1) })
      const listing = await loadListing({ accounts: [savings, cheque], ...range, fetchPage, cap: 50 })
      expect(listing).toMatchObject({ rowCount: 50, capped: true })
      expect(listing.sections.map((s) => [s.rows.length, s.status])).toEqual([[50, 'complete'], [0, 'not-listed']])
    })

    it('marks every Account after the cut-off as not listed, without asking about them', async () => {
      const { fetchPage, requests } = pretendApi({ 1: many(80), 2: many(5), 3: many(5) })
      const listing = await loadListing({ accounts: [savings, cheque, call], ...range, fetchPage, cap: 50 })
      expect(listing.sections.map((s) => [s.rows.length, s.status])).toEqual([[50, 'partial'], [0, 'not-listed'], [0, 'not-listed']])
      expect(new Set(requests.map((r) => r.accountId))).toEqual(new Set([1]))
    })

    it('still says an Account with nothing in the range has nothing, when the cap is reached later on', async () => {
      // The second Account was asked about (the probe found it empty), so "nothing in these dates" is true of it.
      const { fetchPage } = pretendApi({ 1: many(50), 3: many(1) })
      const listing = await loadListing({ accounts: [savings, cheque, call], ...range, fetchPage, cap: 50 })
      expect(listing.sections.map((s) => [s.rows.length, s.status])).toEqual([[50, 'complete'], [0, 'complete'], [0, 'not-listed']])
    })

    it('does not ask for more than will fit, so no page is wasted', async () => {
      const { fetchPage, requests } = pretendApi({ 1: many(40), 2: many(40) })
      await loadListing({ accounts: [savings, cheque], ...range, fetchPage, cap: 50 })
      expect(requests.map((r) => r.limit)).toEqual([50, 10, 1]) // the last only learns that nothing is left out
      expect(requests.at(-1)).toMatchObject({ accountId: 2, after: '10' })
    })

    it('has a cap of 10,000, whole pages', () => {
      expect(REPORT_ROW_CAP).toBe(10_000)
      expect(REPORT_ROW_CAP % REPORT_PAGE_SIZE).toBe(0)
    })
  })

  it('does not list a failed page as an empty one: the failure goes up', async () => {
    const fetchPage = async () => {
      throw new Error('Failed')
    }
    await expect(loadListing({ accounts: [savings], ...range, fetchPage })).rejects.toThrow('Failed')
  })
})

describe('detailsOf (what the bank said about the payment)', () => {
  it('names a cheque number for an Import, and a reference for Sync, as the Transaction details do', () => {
    expect(detailsOf(row({ bankReference: '000123' }))).toEqual(['Cheque number: 000123'])
    expect(detailsOf(row({ source: 'sync', bankReference: 'Ref 77' }))).toEqual(['Reference: Ref 77'])
  })

  it('lists the reference, the counterparty account, the card, the particulars and the code, in that order', () => {
    expect(
      detailsOf(row({ source: 'sync', bankPaymentCode: 'Oct', bankParticulars: 'Rent', bankCardSuffix: '1234', bankCounterpartyAccount: '99-9999-9999999-97', bankReference: 'Ref 77' })),
    ).toEqual(['Reference: Ref 77', 'Counterparty account: 99-9999-9999999-97', 'Card: Ending 1234', 'Particulars: Rent', 'Code: Oct'])
  })

  it('leaves out what is missing or blank', () => {
    expect(detailsOf(row())).toEqual([])
    expect(detailsOf(row({ bankReference: '  ', bankParticulars: '', bankPaymentCode: 'Oct' }))).toEqual(['Code: Oct'])
  })
})

describe('parseReportSearch', () => {
  it('reads the Account and the dates the Transactions page carries', () => {
    expect(parseReportSearch({ account: 2, from: '2026-10-01', to: '2026-10-31' })).toEqual({ account: 2, from: '2026-10-01', to: '2026-10-31' })
    expect(parseReportSearch({ account: '2' })).toEqual({ account: 2 }) // the router has usually parsed it to a number; a string works too
  })

  it('leaves out anything that is not valid rather than refusing the page', () => {
    expect(parseReportSearch({ account: 'x', from: '2026-02-30', to: 'soon' })).toEqual({})
    expect(parseReportSearch({ account: -1, from: '1999-12-31', to: '2101-01-01' })).toEqual({})
    expect(parseReportSearch({})).toEqual({})
  })
})
