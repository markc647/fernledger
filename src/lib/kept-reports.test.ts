import { describe, expect, it } from 'vitest'
import { keepRequest, keptAccount, keptDates, keptHref, keptInSentence, keptLoan, keptName, keptRowName, reportOf, slugOf, type KeptReport } from './kept-reports'
import { REPORTS } from './reports'

const kept = (over: Partial<KeptReport> = {}): KeptReport => ({
  id: 1,
  report: 'spending',
  accountId: null,
  accountName: null,
  categoryId: null,
  categoryName: null,
  categoryRemoved: false,
  from: '2026-10-01',
  to: '2026-10-31',
  lastMadeAt: '2026-10-16T01:00:00.000Z',
  madeBy: 'admin@example.com',
  ...over,
})

describe('what the Report page sends to keep the Report it shows', () => {
  it('names the Report as the Worker does, by the last part of its address, for each of the six', () => {
    expect(Object.values(REPORTS).map(slugOf)).toEqual(['spending', 'income-vs-spending', 'loans', 'transactions', 'balances', 'budget-vs-actual'])
  })

  it('sends the Account, the dates and the Report; no Account for all of them', () => {
    expect(keepRequest(REPORTS.spending, { account: 3, from: '2026-10-01', to: '2026-10-31' })).toEqual({ report: 'spending', accountId: 3, from: '2026-10-01', to: '2026-10-31' })
    expect(keepRequest(REPORTS.transactions, { from: '2026-10-01', to: '2026-10-31' })).toEqual({ report: 'transactions', from: '2026-10-01', to: '2026-10-31' })
  })

  it('sends only the choices the Report has: a Budget has no Account, and a Loans Report a Category and no Account', () => {
    expect(keepRequest(REPORTS.budgetVsActual, { account: 3, category: 2, from: '2026-10-01', to: '2026-10-31' })).toEqual({ report: 'budget-vs-actual', from: '2026-10-01', to: '2026-10-31' })
    expect(keepRequest(REPORTS.loans, { account: 3, category: 2, from: '2026-10-01', to: '2026-10-31' })).toEqual({ report: 'loans', categoryId: 2, from: '2026-10-01', to: '2026-10-31' })
    expect(keepRequest(REPORTS.spending, { account: 3, category: 2, from: '2026-10-01', to: '2026-10-31' })).toEqual({ report: 'spending', accountId: 3, from: '2026-10-01', to: '2026-10-31' })
  })

  it('leaves out the start of a Loans Report that begins at the first Transaction, rather than send a date', () => {
    expect(keepRequest(REPORTS.loans, { to: '2026-10-31' })).toEqual({ report: 'loans', to: '2026-10-31' })
  })
})

describe('a kept Report', () => {
  it('opens at its Report\'s page with its choices, as the Report\'s form would put them in the address', () => {
    expect(keptHref(kept({ accountId: 3, accountName: 'Example savings' }))).toBe('/reports/spending?account=3&from=2026-10-01&to=2026-10-31')
    expect(keptHref(kept({ report: 'budget-vs-actual' }))).toBe('/reports/budget-vs-actual?from=2026-10-01&to=2026-10-31')
    expect(keptHref(kept({ report: 'loans', categoryId: 7, categoryName: 'Loan – Alice', from: null }))).toBe('/reports/loans?category=7&to=2026-10-31')
    expect(keptHref(kept({ report: 'income-vs-spending' }))).toBe('/reports/income-vs-spending?from=2026-10-01&to=2026-10-31')
  })

  it('has no address when its Report is not one this version knows', () => {
    expect(keptHref({ ...kept(), report: 'nonsense' as KeptReport['report'] })).toBeNull()
    expect(reportOf({ report: 'nonsense' as KeptReport['report'] })).toBeUndefined()
    expect(keptName({ ...kept(), report: 'nonsense' as KeptReport['report'] })).toBe('A Report this version does not know')
  })

  it('is named by its Report, as the Reports page and the Report call it', () => {
    expect(keptName(kept())).toBe('Spending by Category')
    expect(keptName(kept({ report: 'income-vs-spending' }))).toBe('Income vs spending by month')
  })

  it('says its dates as a Report\'s title block does, and a Loans Report from its start', () => {
    expect(keptDates(kept())).toBe('Thu 1 Oct 2026 to Sat 31 Oct 2026')
    expect(keptDates(kept({ report: 'loans', from: null }))).toBe('From the first Transaction to Sat 31 Oct 2026')
    expect(keptDates(kept({ from: '2026-10-31' }))).toBe('Sat 31 Oct 2026')
  })

  it('says its Account, or all of them, and all of them for a Report that has none', () => {
    expect(keptAccount(kept({ accountId: 3, accountName: 'Example savings' }))).toBe('Example savings')
    expect(keptAccount(kept())).toBe('All Accounts')
    expect(keptAccount(kept({ report: 'budget-vs-actual' }))).toBe('All Accounts')
    expect(keptAccount(kept({ accountId: 3 }))).toBe('An Account that is no longer here')
  })

  it('says the Loans Category of a Loans Report, all of them, and when the Category has been removed; and nothing of another Report', () => {
    expect(keptLoan(kept({ report: 'loans', categoryId: 7, categoryName: 'Loan – Alice', from: null }))).toBe('Loan – Alice')
    expect(keptLoan(kept({ report: 'loans', from: null }))).toBe('All loans')
    expect(keptLoan(kept({ report: 'loans', categoryId: 7, categoryName: 'Loan – Alice', categoryRemoved: true }))).toBe('Loan – Alice (removed)')
    expect(keptLoan(kept())).toBeNull()
  })

  it('reads in a sentence with a capital only on a name or a date: all Accounts, from the first Transaction, all loans', () => {
    expect(keptInSentence(kept({ accountId: 3, accountName: 'Example savings' }))).toBe('Spending by Category Report, Thu 1 Oct 2026 to Sat 31 Oct 2026, Example savings')
    expect(keptInSentence(kept())).toBe('Spending by Category Report, Thu 1 Oct 2026 to Sat 31 Oct 2026, all Accounts')
    expect(keptInSentence(kept({ report: 'loans', from: null }))).toBe('Loans Report for all loans, from the first Transaction to Sat 31 Oct 2026, all Accounts')
    expect(keptInSentence(kept({ report: 'loans', categoryId: 7, categoryName: 'Loan – Alice', categoryRemoved: true }))).toBe('Loans Report for Loan – Alice (removed), Thu 1 Oct 2026 to Sat 31 Oct 2026, all Accounts')
    expect(keptInSentence(kept({ report: 'loans', categoryId: 7 }))).toBe('Loans Report for a Category that is no longer here, Thu 1 Oct 2026 to Sat 31 Oct 2026, all Accounts')
    expect(keptInSentence(kept({ accountId: 3 }))).toBe('Spending by Category Report, Thu 1 Oct 2026 to Sat 31 Oct 2026, an Account that is no longer here')
    expect(keptInSentence({ ...kept(), report: 'nonsense' as KeptReport['report'] })).toBe('Report that this version does not know, Thu 1 Oct 2026 to Sat 31 Oct 2026, all Accounts')
  })

  it('has a name that tells it from the others, for the button of its row\'s actions', () => {
    expect(keptRowName(kept({ accountId: 3, accountName: 'Example savings' }))).toBe('Spending by Category, Thu 1 Oct 2026 to Sat 31 Oct 2026, Example savings')
    expect(keptRowName(kept({ report: 'loans', categoryId: 7, categoryName: 'Loan – Alice', from: null }))).toBe('Loans, Loan – Alice, From the first Transaction to Sat 31 Oct 2026, All Accounts')
    expect(keptRowName(kept())).not.toBe(keptRowName(kept({ to: '2026-10-30' })))
  })
})
