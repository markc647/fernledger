import { describe, expect, it } from 'vitest'
import { netWorthPoints } from './net-worth'
import type { HistoryRow } from './report-balances'

// The adding-up of net worth (net-worth.ts), with no database: what each Account's picked rows (REPORT_HISTORY) become. How the rows come out of
// balance history, and that the totals hold to it, is tested through the Worker in charts.test.ts. All the figures are made up.

const first = (date: string, balanceCents: number): HistoryRow => ({ kind: 'first', date, balanceCents })
const last = (date: string, balanceCents: number): HistoryRow => ({ kind: 'last', date, balanceCents })
const month = (date: string, balanceCents: number): HistoryRow => ({ kind: 'month', date, balanceCents })
const dates = (points: { date: string }[]) => points.map((p) => p.date)
const totals = (points: { cents: number }[]) => points.map((p) => p.cents)

describe('netWorthPoints', () => {
  it('is nothing for no Accounts, or Accounts with no balances', () => {
    expect(netWorthPoints([])).toEqual([])
    expect(netWorthPoints([[], []])).toEqual([])
  })

  it('is one Account\'s balance at the end of each month, the last month ending on the last date held', () => {
    const rows = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), month('2026-07-31', 14_000), month('2026-08-15', 12_000), month('2026-10-07', 12_300)]

    expect(netWorthPoints([rows])).toEqual([
      { date: '2026-07-31', cents: 14_000 },
      { date: '2026-08-31', cents: 12_000 },
      { date: '2026-09-30', cents: 12_000 }, // no Transactions: the balance carries forward
      { date: '2026-10-07', cents: 12_300 },
    ])
  })

  it('adds the Accounts together, an Account that begins later counting at the balance it opened with before its first date', () => {
    const savings = [first('2026-07-10', 10_000), last('2026-10-07', 12_300), month('2026-07-31', 14_000), month('2026-08-15', 12_000), month('2026-10-07', 12_300)]
    const cheque = [first('2026-09-12', 50_000), last('2026-10-03', 50_223), month('2026-09-12', 49_223), month('2026-10-03', 50_223)]

    const points = netWorthPoints([savings, cheque])

    expect(dates(points)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-07'])
    expect(totals(points)).toEqual([14_000 + 50_000, 12_000 + 50_000, 12_000 + 49_223, 12_300 + 50_223])
  })

  it('does not depend on the order of the Accounts', () => {
    const a = [first('2026-07-10', 100), last('2026-08-20', 150), month('2026-07-10', 120), month('2026-08-20', 150)]
    const b = [first('2026-08-01', 1000), last('2026-09-30', 900), month('2026-08-31', 950), month('2026-09-30', 900)]

    expect(netWorthPoints([a, b])).toEqual(netWorthPoints([b, a]))
  })

  it('keeps an Account that stops early at its last balance, and runs to the latest date any Account holds', () => {
    const early = [first('2026-07-10', 100), last('2026-07-20', 150), month('2026-07-20', 150)]
    const late = [first('2026-07-12', 1000), last('2026-09-05', 800), month('2026-07-31', 900), month('2026-09-05', 800)]

    expect(netWorthPoints([early, late])).toEqual([
      { date: '2026-07-31', cents: 150 + 900 },
      { date: '2026-08-31', cents: 150 + 900 },
      { date: '2026-09-05', cents: 150 + 800 },
    ])
  })

  it('leaves out an Account with no rows and adds the rest', () => {
    const counted = [first('2026-07-10', 100), last('2026-07-20', 150), month('2026-07-20', 150)]

    expect(netWorthPoints([[], counted])).toEqual([{ date: '2026-07-20', cents: 150 }])
  })

  it('is one point when everything is in one month, dated the last date held', () => {
    expect(netWorthPoints([[first('2026-10-01', 0), last('2026-10-09', 500), month('2026-10-09', 500)]])).toEqual([{ date: '2026-10-09', cents: 500 }])
  })

  it('adds negative balances, and can total below zero', () => {
    const credit = [first('2026-07-01', -5000), last('2026-07-31', -7500), month('2026-07-31', -7500)]
    const savings = [first('2026-07-01', 1000), last('2026-07-31', 2000), month('2026-07-31', 2000)]

    expect(netWorthPoints([credit, savings])).toEqual([{ date: '2026-07-31', cents: -5500 }])
  })

  it('runs across the end of a year', () => {
    const rows = [first('2026-12-20', 100), last('2027-02-03', 400), month('2026-12-31', 200), month('2027-02-03', 400)]

    expect(netWorthPoints([rows])).toEqual([
      { date: '2026-12-31', cents: 200 },
      { date: '2027-01-31', cents: 200 },
      { date: '2027-02-03', cents: 400 },
    ])
  })

  it('ends a leap February on the 29th', () => {
    const rows = [first('2028-02-01', 100), last('2028-04-10', 100), month('2028-02-10', 150), month('2028-04-10', 100)]

    expect(dates(netWorthPoints([rows]))).toEqual(['2028-02-29', '2028-03-31', '2028-04-10'])
  })
})
