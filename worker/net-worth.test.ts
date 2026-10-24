import * as z from 'zod/mini'
import { describe, expect, it } from 'vitest'
import { netWorthPoints, netWorthQuery, rangeStart } from './net-worth'
import type { HistoryRow } from './report-balances'

// The adding-up of net worth (net-worth.ts), with no database: what each Account's picked rows (REPORT_HISTORY) become. How the rows come out of
// balance history, and that the totals hold to it, is tested through the Worker in charts.test.ts. All the figures are made up.

const first = (date: string, balanceCents: number): HistoryRow => ({ kind: 'first', date, balanceCents })
const last = (date: string, balanceCents: number): HistoryRow => ({ kind: 'last', date, balanceCents })
const before = (date: string, balanceCents: number): HistoryRow => ({ kind: 'before', date, balanceCents })
const month = (date: string, balanceCents: number): HistoryRow => ({ kind: 'month', date, balanceCents })
const dates = (points: { date: string }[]) => points.map((p) => p.date)
const totals = (points: { cents: number }[]) => points.map((p) => p.cents)
const ALL = '0000-01-01' // a range of every month: it begins before any Transaction

describe('netWorthPoints', () => {
  it('is nothing for no Accounts, or Accounts with no balances', () => {
    expect(netWorthPoints([], ALL)).toEqual([])
    expect(netWorthPoints([[], []], ALL)).toEqual([])
  })

  it('is one Account\'s balance at the end of each month, the last month ending on the last date held', () => {
    const rows = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), month('2026-07-31', 14_000), month('2026-08-15', 12_000), month('2026-10-07', 12_300)]

    expect(netWorthPoints([rows], ALL)).toEqual([
      { date: '2026-07-31', cents: 14_000 },
      { date: '2026-08-31', cents: 12_000 },
      { date: '2026-09-30', cents: 12_000 }, // no Transactions: the balance carries forward
      { date: '2026-10-07', cents: 12_300 },
    ])
  })

  it('adds the Accounts together, an Account that begins later counting at the balance it opened with before its first date', () => {
    const savings = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), month('2026-07-31', 14_000), month('2026-08-15', 12_000), month('2026-10-07', 12_300)]
    const cheque = [first('2026-09-12', 50_000), last('2026-10-03', 50_223), month('2026-09-12', 49_223), month('2026-10-03', 50_223)]

    const points = netWorthPoints([savings, cheque], ALL)

    expect(dates(points)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-07'])
    expect(totals(points)).toEqual([14_000 + 50_000, 12_000 + 50_000, 12_000 + 49_223, 12_300 + 50_223])
  })

  it('does not depend on the order of the Accounts', () => {
    const a = [first('2026-07-10', 100), last('2026-08-20', 150), month('2026-07-10', 120), month('2026-08-20', 150)]
    const b = [first('2026-08-01', 1000), last('2026-09-30', 900), month('2026-08-31', 950), month('2026-09-30', 900)]

    expect(netWorthPoints([a, b], ALL)).toEqual(netWorthPoints([b, a], ALL))
  })

  it('keeps an Account that stops early at its last balance, and runs to the latest date any Account holds', () => {
    const early = [first('2026-07-10', 100), last('2026-07-20', 150), month('2026-07-20', 150)]
    const late = [first('2026-07-12', 1000), last('2026-09-05', 800), month('2026-07-31', 900), month('2026-09-05', 800)]

    expect(netWorthPoints([early, late], ALL)).toEqual([
      { date: '2026-07-31', cents: 150 + 900 },
      { date: '2026-08-31', cents: 150 + 900 },
      { date: '2026-09-05', cents: 150 + 800 },
    ])
  })

  it('leaves out an Account with no rows and adds the rest', () => {
    const counted = [first('2026-07-10', 100), last('2026-07-20', 150), month('2026-07-20', 150)]

    expect(netWorthPoints([[], counted], ALL)).toEqual([{ date: '2026-07-20', cents: 150 }])
  })

  it('is one point when everything is in one month, dated the last date held', () => {
    expect(netWorthPoints([[first('2026-10-01', 0), last('2026-10-09', 500), month('2026-10-09', 500)]], ALL)).toEqual([{ date: '2026-10-09', cents: 500 }])
  })

  it('adds negative balances, and can total below zero', () => {
    const credit = [first('2026-07-01', -5000), last('2026-07-31', -7500), month('2026-07-31', -7500)]
    const savings = [first('2026-07-01', 1000), last('2026-07-31', 2000), month('2026-07-31', 2000)]

    expect(netWorthPoints([credit, savings], ALL)).toEqual([{ date: '2026-07-31', cents: -5500 }])
  })

  it('runs across the end of a year', () => {
    const rows = [first('2026-12-20', 100), last('2027-02-03', 400), month('2026-12-31', 200), month('2027-02-03', 400)]

    expect(netWorthPoints([rows], ALL)).toEqual([
      { date: '2026-12-31', cents: 200 },
      { date: '2027-01-31', cents: 200 },
      { date: '2027-02-03', cents: 400 },
    ])
  })

  it('ends a leap February on the 29th', () => {
    const rows = [first('2028-02-01', 100), last('2028-04-10', 100), month('2028-02-10', 150), month('2028-04-10', 100)]

    expect(dates(netWorthPoints([rows], ALL))).toEqual(['2028-02-29', '2028-03-31', '2028-04-10'])
  })

  describe('a range that begins part way through the history', () => {
    // Savings: opened with $100.00 before 10 July; the months it was asked from 1 September on. Its balance at the end of 20 August is the `before` row.
    const savings = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), before('2026-08-20', 12_000), month('2026-10-07', 12_300)]

    it('starts the first month from the balance before the range, and carries it through the months with no Transactions', () => {
      expect(netWorthPoints([savings], '2026-09-01')).toEqual([
        { date: '2026-09-30', cents: 12_000 },
        { date: '2026-10-07', cents: 12_300 },
      ])
    })

    it('is the same points as the whole history\'s, for the months it shares', () => {
      const whole = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), month('2026-07-31', 14_000), month('2026-08-20', 12_000), month('2026-10-07', 12_300)]

      expect(netWorthPoints([savings], '2026-09-01')).toEqual(netWorthPoints([whole], ALL).slice(2))
    })

    it('counts an Account that has no Transaction before the range at the balance it opened with, as when the range is every month', () => {
      const cheque = [first('2026-09-12', 50_000), last('2026-10-03', 50_223), month('2026-09-12', 49_223), month('2026-10-03', 50_223)]

      // Cheque begins in the range, so it has no `before` row: September's first month is its own first Transaction's, and nothing before is shown.
      expect(totals(netWorthPoints([savings, cheque], '2026-09-01'))).toEqual([12_000 + 49_223, 12_300 + 50_223])
    })

    it('counts an Account that begins after the range\'s first month at the balance it opened with in the months before it', () => {
      const cheque = [first('2026-10-03', 50_000), last('2026-10-03', 50_223), month('2026-10-03', 50_223)]

      expect(totals(netWorthPoints([savings, cheque], '2026-09-01'))).toEqual([12_000 + 50_000, 12_300 + 50_223])
    })

    it('begins at the earliest month held when the range begins before it', () => {
      const rows = [first('2026-07-10', 10_000), last('2026-08-31', 14_000), month('2026-07-31', 14_000), month('2026-08-31', 14_000)]

      expect(dates(netWorthPoints([rows], '2020-01-01'))).toEqual(['2026-07-31', '2026-08-31'])
    })

    it('is the last month alone when the range begins after every Account\'s last date, at the balances they ended with', () => {
      const stopped = [first('2026-07-10', 10_000), last('2026-07-20', 15_000), before('2026-07-20', 15_000)]
      const alsoStopped = [first('2026-06-01', 100), last('2026-06-30', 300), before('2026-06-30', 300)]

      expect(netWorthPoints([stopped, alsoStopped], '2026-10-01')).toEqual([{ date: '2026-07-20', cents: 15_300 }])
    })
  })
})

describe('rangeStart', () => {
  // NZ is UTC+13 in summer (clocks forward on 27 Sept 2026), so 1 October begins at 11:00 UTC on 30 September.
  const now = new Date('2026-10-10T03:00:00Z')

  it('begins the last 24 months 23 months before this one, and the last 5 years 59', () => {
    expect(rangeStart('24-months', now)).toBe('2024-11-01')
    expect(rangeStart('5-years', now)).toBe('2021-11-01')
  })

  it('begins every month before any Transaction', () => {
    expect(rangeStart('all', now)).toBe('0000-01-01')
  })

  it('goes by the NZ month, not the UTC one', () => {
    expect(rangeStart('24-months', new Date('2026-09-30T10:59:59Z'))).toBe('2024-10-01')
    expect(rangeStart('24-months', new Date('2026-09-30T11:00:00Z'))).toBe('2024-11-01')
  })

  it('crosses the start of a year', () => {
    expect(rangeStart('24-months', new Date('2027-01-15T03:00:00Z'))).toBe('2025-02-01')
  })
})

describe('the query string', () => {
  const check = (query: Record<string, string>) => {
    const parsed = z.safeParse(netWorthQuery, query)
    return parsed.success ? 'ok' : parsed.error.issues[0]!.path.join('.')
  }

  it('takes a range, or none', () => {
    expect(check({})).toBe('ok')
    for (const range of ['24-months', '5-years', 'all']) expect(check({ range })).toBe('ok')
  })

  it.each(['', '12-months', 'ALL', 'all,5-years'])('refuses the range %j and names it', (range) => {
    expect(check({ range })).toBe('range')
  })
})
