import { describe, expect, it } from 'vitest'
import { checkBalances, importOutcome, statusOnRecord, syncBalance, type BalanceRow } from './balance-rules'

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

describe('syncBalance', () => {
  // Akahu read the bank at 02:46 UTC on 21 October, which is 15:46 that day in NZ.
  const reported = { akahuBalanceCurrency: 'NZD', akahuBalanceCurrentCents: 70_717, akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z', akahuRefreshedTransactionsAt: '2026-10-21T02:46:00.000Z' }

  it("takes Akahu's balance as of the NZ date it was read, in cents", () => {
    expect(syncBalance(reported, true)).toEqual({ balance: { asOfDate: '2026-10-21', bankCents: 70_717 } })
  })

  it('dates it by the NZ day and not the UTC day', () => {
    const lateUtc = '2026-10-20T20:30:00.000Z' // 09:30 on the 21st in NZ
    expect(syncBalance({ ...reported, akahuRefreshedBalanceAt: lateUtc, akahuRefreshedTransactionsAt: lateUtc }, true)).toEqual({ balance: { asOfDate: '2026-10-21', bankCents: 70_717 } })
  })

  it('takes an overdrawn or zero balance, which are balances', () => {
    expect(syncBalance({ ...reported, akahuBalanceCurrentCents: -1_250 }, true)).toMatchObject({ balance: { bankCents: -1_250 } })
    expect(syncBalance({ ...reported, akahuBalanceCurrentCents: 0 }, true)).toMatchObject({ balance: { bankCents: 0 } })
  })

  it('records nothing when Akahu sent no balance', () => {
    expect(syncBalance({ ...reported, akahuBalanceCurrentCents: null }, true)).toEqual({ skipped: 'no-balance' })
    expect(syncBalance({ ...reported, akahuRefreshedBalanceAt: null }, true)).toEqual({ skipped: 'no-balance' })
  })

  it('records nothing when the Sync did not finish, because the Transactions held are not all of those Akahu has', () => {
    expect(syncBalance(reported, false)).toEqual({ skipped: 'incomplete' })
  })

  it('records nothing when Akahu read the balance and the Transactions at different times, because they would not cover the same Transactions', () => {
    expect(syncBalance({ ...reported, akahuRefreshedTransactionsAt: '2026-10-21T02:47:00.000Z' }, true)).toEqual({ skipped: 'refreshed-apart' })
    expect(syncBalance({ ...reported, akahuRefreshedTransactionsAt: null }, true)).toEqual({ skipped: 'refreshed-apart' })
  })

  it('records nothing in a currency other than NZD, and takes a balance with no currency named', () => {
    expect(syncBalance({ ...reported, akahuBalanceCurrency: 'AUD' }, true)).toEqual({ skipped: 'currency' })
    expect(syncBalance({ ...reported, akahuBalanceCurrency: null }, true)).toMatchObject({ balance: { asOfDate: '2026-10-21' } })
  })
})

describe("checkBalances with Akahu's balance", () => {
  it('leaves the first Akahu balance alone, and counts it although it is after the Cutover Date', () => {
    // A file balance dated on the Cutover Date is after-cutover and uncounted; Akahu's own, dated later, is counted and anchors.
    const results = checkBalances([balance('2026-09-17', 5000, 0, 'after-cutover'), balance('2026-10-21', 70_717, 1000)])
    expect(results.map((r) => r.status)).toEqual(['after-cutover', 'alone'])
  })

  it("matches the next Akahu balance when the Transactions since explain the change", () => {
    const [, first, second] = checkBalances([balance('2026-09-17', 5000, 0, 'after-cutover'), balance('2026-10-21', 70_717, 1000), balance('2026-10-22', 69_717, 1000)])
    expect(first!.status).toBe('alone')
    expect(second).toEqual({ asOfDate: '2026-10-22', status: 'matched', checkedAgainst: '2026-10-21', calculatedCents: 69_717, differenceCents: 0 })
  })

  it('differs when a Transaction is missing, dated after the previous Akahu balance', () => {
    const [, , second] = checkBalances([balance('2026-09-17', 5000, 0, 'after-cutover'), balance('2026-10-21', 70_717, 1000), balance('2026-10-22', 60_717, 11_000)])
    expect(second).toEqual({ asOfDate: '2026-10-22', status: 'differs', checkedAgainst: '2026-10-21', calculatedCents: 50_717, differenceCents: 10_000 })
  })

  it('compares the first Akahu balance with an earlier file balance that is counted', () => {
    const results = checkBalances([balance('2026-09-16', 5000, 1000), balance('2026-10-21', 70_717, 1000)])
    expect(results[1]).toMatchObject({ status: 'matched', checkedAgainst: '2026-09-16' })
  })
})
