import * as z from 'zod/mini'
import { describe, expect, it } from 'vitest'
import { periodDates, rangeOf, spendingQuery } from './chart-spending'

// The question the spending chart asks (chart-spending.ts): its periods and its query string. The answer, which a Report of it shares, is
// spending-by-category.test.ts; what counts as Spending is spending.ts's, tested in spending.test.ts; the Worker boundary is charts.test.ts.

describe('periodDates', () => {
  // NZ is UTC+13 in summer (clocks forward on 27 Sept 2026) and UTC+12 in winter, so a month changes at 11:00 or 12:00 UTC the day before.
  it.each([
    ['this-month', '2026-10-10T03:00:00Z', '2026-10-01', '2026-10-31'],
    ['last-month', '2026-10-10T03:00:00Z', '2026-09-01', '2026-09-30'],
    ['past-3-months', '2026-10-10T03:00:00Z', '2026-08-01', '2026-10-31'],
    ['past-12-months', '2026-10-10T03:00:00Z', '2025-11-01', '2026-10-31'],
    // Across the start of a year.
    ['last-month', '2027-01-15T03:00:00Z', '2026-12-01', '2026-12-31'],
    ['past-3-months', '2027-01-15T03:00:00Z', '2026-11-01', '2027-01-31'],
    ['past-12-months', '2027-01-15T03:00:00Z', '2026-02-01', '2027-01-31'],
    // A leap February, and a short one.
    ['this-month', '2028-02-10T03:00:00Z', '2028-02-01', '2028-02-29'],
    ['last-month', '2026-03-10T03:00:00Z', '2026-02-01', '2026-02-28'],
  ] as const)('%s at %s is %s to %s', (period, now, from, to) => {
    expect(periodDates(period, new Date(now))).toEqual({ from, to })
  })

  it('goes by the NZ month, not the UTC one: 1 October in NZ is still 30 September in UTC', () => {
    expect(periodDates('this-month', new Date('2026-09-30T10:59:59Z'))).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodDates('this-month', new Date('2026-09-30T11:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31' }) // midnight, 1 Oct, summer time
    expect(periodDates('this-month', new Date('2026-06-30T11:59:59Z'))).toEqual({ from: '2026-06-01', to: '2026-06-30' })
    expect(periodDates('this-month', new Date('2026-06-30T12:00:00Z'))).toEqual({ from: '2026-07-01', to: '2026-07-31' }) // midnight, 1 July, winter time
  })
})

describe('the query string', () => {
  const check = (query: Record<string, string>) => {
    const parsed = z.safeParse(spendingQuery, query)
    return parsed.success ? 'ok' : parsed.error.issues[0]!.path.join('.')
  }

  it('takes a named period, or both dates', () => {
    expect(check({ period: 'this-month' })).toBe('ok')
    expect(check({ period: 'past-12-months' })).toBe('ok')
    expect(check({ from: '2026-10-01', to: '2026-10-31' })).toBe('ok')
    expect(check({ from: '2026-10-09', to: '2026-10-09' })).toBe('ok')
  })

  it.each([
    [{}, 'period'],
    [{ period: 'this-year' }, 'period'],
    [{ period: '' }, 'period'],
    [{ period: 'this-month', from: '2026-10-01' }, 'period'],
    [{ period: 'this-month', to: '2026-10-31' }, 'period'],
    [{ from: '2026-10-01' }, 'to'],
    [{ to: '2026-10-31' }, 'from'],
    [{ from: '2026-10-31', to: '2026-10-01' }, 'to'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'from'],
    [{ from: '2026-10-01', to: 'tomorrow' }, 'to'],
    [{ from: '1999-12-31', to: '2026-10-01' }, 'from'],
    [{ from: '2026-10-01', to: '2101-01-01' }, 'to'],
  ])('refuses %j and names %s', (query, field) => {
    expect(check(query)).toBe(field)
  })
})

describe('rangeOf', () => {
  const now = new Date('2026-10-10T03:00:00Z')

  it('is the named period\'s dates, or the dates given', () => {
    expect(rangeOf({ period: 'last-month' }, now)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(rangeOf({ from: '2026-08-15', to: '2026-09-02' }, now)).toEqual({ from: '2026-08-15', to: '2026-09-02' })
  })
})
