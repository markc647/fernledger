import { describe, expect, it } from 'vitest'
import { budgetRows } from './budgets'
import {
  hasNoBudgets,
  monthNote,
  monthsTouched,
  MAX_REPORT_MONTHS,
  overMonthsText,
  parseBudgetReportSearch,
  periodRows,
  togetherCovers,
  tooManyMonths,
  wholeMonthsNotice,
  type BudgetReport,
  type MonthState,
  type ReportMonth,
} from './report-budget'

const month = (name: string, state: MonthState = 'ended', rows: [number, number, number][] = []): ReportMonth => ({
  month: name,
  state,
  rows: rows.map(([categoryId, budgetCents, spentCents]) => ({ categoryId, categoryName: `Category ${categoryId}`, budgetCents, spentCents, effectiveFrom: name, changed: false })),
  otherCents: 0,
  uncategorisedCents: 0,
  budgetCents: 0,
  budgetedSpentCents: 0,
  spentCents: 0,
})

const report = (over: Partial<BudgetReport> = {}): BudgetReport => ({
  from: '2026-01-01',
  to: '2026-03-31',
  covers: { from: '2026-01-01', to: '2026-03-31' },
  months: [],
  together: null,
  total: { budgetCents: 0, budgetedSpentCents: 0, spentCents: 0, otherCents: 0, uncategorisedCents: 0, budgetMonths: 0, overMonths: 0 },
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

describe('monthNote', () => {
  it('says so for a month that has not ended, and that it is left out of the months together, and nothing for one that has', () => {
    expect(monthNote('ended')).toBeNull()
    expect(monthNote('under-way')).toContain('not over yet')
    expect(monthNote('under-way')).toContain('whole month’s Budget')
    expect(monthNote('under-way')).toContain('not in the months together')
    expect(monthNote('not-begun')).toBe('This month has not begun, so nothing has been spent yet. It is not in the months together.')
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

describe('togetherCovers', () => {
  const months = (states: MonthState[]) => states.map((state, i) => month(`2026-${String(i + 1).padStart(2, '0')}`, state))
  const ended = (n: number) => ({ first: '2026-01', last: `2026-${String(n).padStart(2, '0')}`, months: n })

  it('names the months that have ended when all of them have', () => {
    expect(togetherCovers(report({ months: months(['ended', 'ended', 'ended']), together: ended(3) }))).toBe('These figures cover January 2026 to March 2026, the 3 months that have ended.')
  })

  it('says why the month it is now and the months to come are left out, and that each is shown on its own', () => {
    const states = ['ended', 'ended', 'under-way', 'not-begun', 'not-begun'] as MonthState[]

    expect(togetherCovers(report({ months: months(states), together: ended(2) }))).toBe(
      'These figures cover January 2026 to February 2026, the 2 months that have ended. March 2026 is not over yet, so part of its spending would be set against the whole of its Budget. ' +
        'April 2026 to May 2026 have not begun, so their Budget would be set against no spending at all. They are left out of these figures, and shown on their own below.',
    )
  })

  it('says so for one month left out, and for one month that has ended', () => {
    expect(togetherCovers(report({ months: months(['ended', 'not-begun']), together: ended(1) }))).toBe(
      'These figures are for January 2026, the one month that has ended. February 2026 has not begun, so its Budget would be set against no spending at all. It is left out of these figures, and shown on its own below.',
    )
  })

  it('says there is nothing to add together while no month has ended', () => {
    expect(togetherCovers(report({ months: months(['under-way', 'not-begun']), together: null }))).toBe('No month in these dates has ended, so there is nothing to add together yet.')
  })
})

describe('hasNoBudgets', () => {
  it('is true only while no month has a Category with a Budget', () => {
    expect(hasNoBudgets(report({ months: [month('2026-01'), month('2026-02')] }))).toBe(true)
    expect(hasNoBudgets(report({ months: [month('2026-01'), month('2026-02', 'ended', [[1, 1_000, 0]])] }))).toBe(false)
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
    const rows = periodRows(
      report({
        categories: [{ categoryId: 1, categoryName: 'Category 1', months: 2, overMonths: 1, budgetCents: 2_000, spentCents: 2_000 }],
        total: { budgetCents: 2_000, budgetedSpentCents: 2_000, spentCents: 2_500, otherCents: 700, uncategorisedCents: -200, budgetMonths: 2, overMonths: 1 },
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

describe('a month’s rows with a Budget that changed', () => {
  it('say from which month under the Category’s name, for a changed Budget only', () => {
    const rows = budgetRows({
      rows: [
        { categoryId: 1, categoryName: 'Groceries', budgetCents: 90_000, spentCents: 100, effectiveFrom: '2026-03', changed: true },
        { categoryId: 2, categoryName: 'Fuel', budgetCents: 9_000, spentCents: 100, effectiveFrom: '2026-01', changed: false },
      ],
      otherCents: 0,
      uncategorisedCents: 0,
    })

    expect(rows[0]).toMatchObject({ name: 'Groceries', note: 'Budget changed from March 2026' })
    expect(rows[1]!.note).toBeUndefined()
  })
})
