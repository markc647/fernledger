import { describe, expect, it } from 'vitest'
import { isSameReport, reportHref } from './report-address'

describe('reportHref', () => {
  it('is the Report\'s page and what was chosen, in the order the form has it, as a plain form sends it', () => {
    expect(
      reportHref('/reports/transactions', [
        ['account', '2'],
        ['from', '2026-01-01'],
        ['to', '2026-12-31'],
      ]),
    ).toBe('/reports/transactions?account=2&from=2026-01-01&to=2026-12-31')
  })

  it('leaves out a choice that is blank (All Accounts, a From left empty), and anything that is not text', () => {
    expect(
      reportHref('/reports/loans', [
        ['category', ''],
        ['from', ''],
        ['to', '2026-10-31'],
        ['upload', new File([], 'a.txt')],
      ]),
    ).toBe('/reports/loans?to=2026-10-31')
  })

  it('is just the page when nothing was chosen', () => {
    expect(reportHref('/reports/loans', [])).toBe('/reports/loans')
  })
})

describe('isSameReport', () => {
  const here = (search: string, pathname = '/reports/spending') => ({ pathname, search })
  const READS = ['account', 'from', 'to']

  it('is true for the page that is open with the same choices, whatever order they come in', () => {
    expect(isSameReport('/reports/spending?account=2&from=2026-01-01&to=2026-12-31', here('?to=2026-12-31&account=2&from=2026-01-01'), READS)).toBe(true)
    expect(isSameReport('/reports/spending', here(''), READS)).toBe(true)
  })

  it('does not count a blank choice, which an address from an earlier form (or a bookmark of one) has', () => {
    expect(isSameReport('/reports/spending?from=2026-01-01&to=2026-12-31', here('?account=&from=2026-01-01&to=2026-12-31'), READS)).toBe(true)
  })

  it('does not count a choice the Report does not read: a Budget has no Account', () => {
    const budget = ['from', 'to']
    expect(isSameReport('/reports/budget-vs-actual?from=2026-01-01&to=2026-12-31', here('?account=2&from=2026-01-01&to=2026-12-31', '/reports/budget-vs-actual'), budget)).toBe(true)
    expect(isSameReport('/reports/budget-vs-actual?from=2026-01-01&to=2026-12-31', here('?account=2&from=2026-01-01&to=2026-11-30', '/reports/budget-vs-actual'), budget)).toBe(false)
  })

  it('is false when a choice, a page or a choice\'s presence differs', () => {
    expect(isSameReport('/reports/spending?from=2026-01-01&to=2026-12-31', here('?from=2026-01-01&to=2026-11-30'), READS)).toBe(false)
    expect(isSameReport('/reports/spending?from=2026-01-01&to=2026-12-31', here('?from=2026-01-01&to=2026-12-31', '/reports/loans'), READS)).toBe(false)
    expect(isSameReport('/reports/spending?from=2026-01-01&to=2026-12-31', here('?from=2026-01-01&to=2026-12-31&account=2'), READS)).toBe(false)
    expect(isSameReport('/reports/spending?from=2026-01-01&to=2026-12-31&account=2', here('?from=2026-01-01&to=2026-12-31'), READS)).toBe(false)
  })
})
