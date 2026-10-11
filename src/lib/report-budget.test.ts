import { describe, expect, it } from 'vitest'
import {
  monthNote,
  monthsOver,
  monthsTouched,
  monthState,
  MAX_REPORT_MONTHS,
  overMonthsText,
  parseBudgetReportSearch,
  periodRows,
  tooManyMonths,
  wholeMonthsNotice,
  type BudgetReport,
  type ReportMonth,
} from './report-budget'

const month = (name: string, rows: [number, number, number][]): ReportMonth => ({
  month: name,
  rows: rows.map(([categoryId, budgetCents, spentCents]) => ({ categoryId, categoryName: `Category ${categoryId}`, budgetCents, spentCents })),
  otherCents: 0,
  uncategorisedCents: 0,
  budgetCents: 0,
  spentCents: 0,
})

const report = (over: Partial<BudgetReport> = {}): BudgetReport => ({
  from: '2026-01-01',
  to: '2026-03-31',
  covers: { from: '2026-01-01', to: '2026-03-31' },
  thisMonth: '2026-10',
  months: [],
  total: { budgetCents: 0, spentCents: 0, otherCents: 0, uncategorisedCents: 0 },
  categories: [],
  ...over,
})

describe('parseBudgetReportSearch', () => {
  it('reads the dates and sets the Account to nothing, because a Budget is for all of them together (the router passes on an address parameter that a route leaves out, so it is set, not left out)', () => {
    expect(parseBudgetReportSearch({ account: 2, from: '2026-01-01', to: '2026-03-31' })).toStrictEqual({ account: undefined, from: '2026-01-01', to: '2026-03-31' })
    expect(parseBudgetReportSearch({ account: '2' })).toStrictEqual({ account: undefined })
  })

  it('leaves out a date that is not a real one, rather than refusing the address', () => {
    expect(parseBudgetReportSearch({ from: '2026-02-30', to: 'tomorrow' })).toEqual({})
    expect(parseBudgetReportSearch({ from: '2026-02-01' })).toEqual({ from: '2026-02-01' })
  })
})

describe('the months a Report covers', () => {
  it.each([
    ['2026-03-05', '2026-03-05', 1],
    ['2026-01-31', '2026-02-01', 2],
    ['2026-11-30', '2027-02-01', 4], // across a year end
    ['2026-01-01', '2026-12-31', 12],
    ['2024-01-01', '2025-12-31', 24],
    ['2024-01-31', '2026-01-01', 25],
  ])('are %s to %s: %i', (from, to, count) => {
    expect(monthsTouched(from, to)).toBe(count)
  })

  it('refuse more than the limit, which the Worker enforces too, and say how many are allowed', () => {
    expect(MAX_REPORT_MONTHS).toBe(24)
    expect(tooManyMonths('2024-01-01', '2025-12-31')).toBeNull()
    expect(tooManyMonths('2024-01-31', '2026-01-01')).toBe('A Budget vs actual Report covers at most 24 months. Choose dates that touch 24 months or fewer.')
  })
})

describe('monthState and monthNote', () => {
  it('know a finished month, the month it is now and one to come', () => {
    expect(monthState('2026-09', '2026-10')).toBe('finished')
    expect(monthState('2026-10', '2026-10')).toBe('under-way')
    expect(monthState('2026-11', '2026-10')).toBe('not-begun')
    expect(monthState('2025-12', '2026-01')).toBe('finished') // across a year end
  })

  it('say so for a month that is not finished, and nothing for one that is', () => {
    expect(monthNote('finished')).toBeNull()
    expect(monthNote('under-way')).toContain('not over yet')
    expect(monthNote('under-way')).toContain('whole month’s Budget')
    expect(monthNote('not-begun')).toBe('This month has not begun, so nothing has been spent yet.')
  })
})

describe('wholeMonthsNotice', () => {
  it('says nothing when the dates are whole months', () => {
    expect(wholeMonthsNotice(report())).toBeNull()
  })

  it('says which dates were chosen and which were covered when either end is part of a month', () => {
    const words = wholeMonthsNotice(report({ from: '2026-01-15', covers: { from: '2026-01-01', to: '2026-03-31' }, to: '2026-03-31' }))

    expect(words).toBe('You chose Thu 15 Jan 2026 to Tue 31 Mar 2026. A Budget is for a whole month, so this Report shows every month those dates touch, in full: Thu 1 Jan 2026 to Tue 31 Mar 2026.')
    expect(wholeMonthsNotice(report({ to: '2026-03-10' }))).toContain('Tue 10 Mar 2026')
  })
})

describe('monthsOver', () => {
  const months = [
    month('2026-01', [[1, 1_000, 900], [2, 500, 600]]), // 2 is over
    month('2026-02', [[1, 1_000, 1_000], [2, 500, 500]]), // exactly the Budget is on Budget, not over
    month('2026-03', [[1, 1_000, 1_001]]), // 1 is over by a cent
    month('2026-04', [[2, 500, -200]]), // money back is not over
  ]

  it('counts the months a Category was over its Budget, by the rule the Summary uses', () => {
    expect(monthsOver(months, 1)).toBe(1)
    expect(monthsOver(months, 2)).toBe(1)
    expect(monthsOver(months, 3)).toBe(0)
  })
})

describe('overMonthsText', () => {
  it('counts the months, in the singular for one', () => {
    expect(overMonthsText(1, 6)).toBe('1 of 6 months')
    expect(overMonthsText(0, 2)).toBe('0 of 2 months')
    expect(overMonthsText(0, 1)).toBe('0 of 1 month')
    expect(overMonthsText(1, 1)).toBe('1 of 1 month')
  })
})

describe('periodRows', () => {
  it('has a row for each Category with a Budget, then Spending outside Budgets and Uncategorised, which have no months over', () => {
    const months = [month('2026-01', [[1, 1_000, 1_100]]), month('2026-02', [[1, 1_000, 900]]), month('2026-03', [])]

    const rows = periodRows(
      report({
        months,
        categories: [{ categoryId: 1, categoryName: 'Category 1', months: 2, budgetCents: 2_000, spentCents: 2_000 }],
        total: { budgetCents: 2_000, spentCents: 2_500, otherCents: 700, uncategorisedCents: -200 },
      }),
    )

    expect(rows).toEqual([
      { key: '1', name: 'Category 1', budgetCents: 2_000, spentCents: 2_000, overMonths: '1 of 2 months' },
      { key: 'other', name: 'Spending outside Budgets', budgetCents: null, spentCents: 700, overMonths: null },
      { key: 'uncategorised', name: 'Uncategorised (includes money in not yet given a Category)', budgetCents: null, spentCents: -200, overMonths: null },
    ])
  })

  it('still has the two rows that are not in a Budget when no Category had one', () => {
    expect(periodRows(report()).map((row) => row.key)).toEqual(['other', 'uncategorised'])
  })
})
