import { describe, expect, it } from 'vitest'
import { checkBalances, importOutcome, statusOnRecord, type BalanceRow } from './balance-rules'

const balance = (asOfDate: string, bankCents: number, openingCents: number, status: BalanceRow['status'] = 'alone'): BalanceRow => ({ asOfDate, bankCents, openingCents, status })

describe('statusOnRecord', () => {
  const file = { asOfDate: '2026-10-02', fileTo: '2026-10-02', cutoverDate: null }

  it('counts a balance as of the last day of its file', () => {
    expect(statusOnRecord(file)).toBe('alone')
  })

  it('counts a balance dated before the Cutover Date, and not one on or after it', () => {
    expect(statusOnRecord({ ...file, cutoverDate: '2026-10-03' })).toBe('alone')
    expect(statusOnRecord({ ...file, cutoverDate: '2026-10-02' })).toBe('after-cutover')
    expect(statusOnRecord({ ...file, cutoverDate: '2026-10-01' })).toBe('after-cutover')
  })

  it('does not count a balance dated after the last day of its file', () => {
    expect(statusOnRecord({ ...file, fileTo: '2026-10-01' })).toBe('file-ends-early')
    expect(statusOnRecord({ ...file, fileTo: '2026-10-03' })).toBe('alone')
  })

  it('names the Cutover Date first when both apply, because Sync supplies those days', () => {
    expect(statusOnRecord({ asOfDate: '2026-10-02', fileTo: '2026-10-01', cutoverDate: '2026-10-01' })).toBe('after-cutover')
  })
})

describe('checkBalances', () => {
  it('leaves a lone balance with nothing to compare', () => {
    expect(checkBalances([balance('2026-10-02', 5000, 1000)])).toEqual([
      { asOfDate: '2026-10-02', status: 'alone', checkedAgainst: null, calculatedCents: null, differenceCents: null },
    ])
  })

  it('matches balances that imply the same opening balance', () => {
    const [first, second] = checkBalances([balance('2026-09-30', 5000, 1000), balance('2026-10-07', 7000, 1000)])
    expect(first!.status).toBe('alone')
    expect(second).toEqual({ asOfDate: '2026-10-07', status: 'matched', checkedAgainst: '2026-09-30', calculatedCents: 7000, differenceCents: 0 })
  })

  it('reports the bank balance minus the calculated one, with the date it was last right', () => {
    const [, second] = checkBalances([balance('2026-09-30', 5000, 1000), balance('2026-10-07', 7000, 800)])
    // The Transactions add up to 200 more than the bank's change, so the calculated balance is 200 too high.
    expect(second).toEqual({ asOfDate: '2026-10-07', status: 'differs', checkedAgainst: '2026-09-30', calculatedCents: 7200, differenceCents: -200 })
    const [, higher] = checkBalances([balance('2026-09-30', 5000, 1000), balance('2026-10-07', 7000, 1250)])
    expect(higher).toMatchObject({ status: 'differs', calculatedCents: 6750, differenceCents: 250 })
  })

  it('compares each balance with the one before it, not with the first', () => {
    const results = checkBalances([balance('2026-09-30', 5000, 1000), balance('2026-10-07', 7000, 900), balance('2026-10-14', 8000, 900)])
    expect(results.map((r) => [r.status, r.checkedAgainst, r.differenceCents])).toEqual([
      ['alone', null, null],
      ['differs', '2026-09-30', -100],
      ['matched', '2026-10-07', 0],
    ])
  })

  it('orders by date, whatever order the balances arrive in', () => {
    const results = checkBalances([balance('2026-10-07', 7000, 1000), balance('2026-09-30', 5000, 1000)])
    expect(results.map((r) => r.asOfDate)).toEqual(['2026-09-30', '2026-10-07'])
    expect(results[1]!.status).toBe('matched')
  })

  it('skips balances that could not be counted, keeping their status and not comparing across them', () => {
    const results = checkBalances([
      balance('2026-09-30', 5000, 1000),
      balance('2026-10-02', 9999, 0, 'after-cutover'),
      balance('2026-10-04', 6000, 0, 'file-ends-early'),
      balance('2026-10-07', 7000, 1000),
    ])
    expect(results.map((r) => [r.asOfDate, r.status, r.checkedAgainst])).toEqual([
      ['2026-09-30', 'alone', null],
      ['2026-10-02', 'after-cutover', null],
      ['2026-10-04', 'file-ends-early', null],
      ['2026-10-07', 'matched', '2026-09-30'],
    ])
  })

  it('treats a zero difference as matched even when both openings are negative', () => {
    const [, second] = checkBalances([balance('2026-09-30', -5000, -9000), balance('2026-10-07', -4000, -9000)])
    expect(second!.status).toBe('matched')
  })
})

describe('importOutcome', () => {
  const results = checkBalances([balance('2026-09-30', 5000, 1000), balance('2026-10-07', 7000, 800), balance('2026-10-14', 8000, 800)])

  it('is the check of the span that ends at the balance just recorded', () => {
    expect(importOutcome(results, '2026-10-07')).toEqual({ status: 'differs', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: -200 })
    expect(importOutcome(results, '2026-10-14')).toEqual({ status: 'matched', asOfDate: '2026-10-14', since: '2026-10-07', differenceCents: 0 })
  })

  it('is the check of the span that starts at the balance when it is the oldest', () => {
    expect(importOutcome(results, '2026-09-30')).toEqual({ status: 'differs', asOfDate: '2026-10-07', since: '2026-09-30', differenceCents: -200 })
  })

  it('says there is nothing to compare for a lone balance, and passes on why a balance was not counted', () => {
    expect(importOutcome(checkBalances([balance('2026-09-30', 5000, 1000)]), '2026-09-30')).toEqual({ status: 'alone', asOfDate: '2026-09-30', since: null, differenceCents: null })
    const skipped = checkBalances([balance('2026-09-30', 5000, 0, 'after-cutover')])
    expect(importOutcome(skipped, '2026-09-30')).toEqual({ status: 'after-cutover', asOfDate: '2026-09-30', since: null, differenceCents: null })
  })

  it('is null for a balance that is not in the list', () => {
    expect(importOutcome(results, '2026-01-01')).toBeNull()
  })
})
