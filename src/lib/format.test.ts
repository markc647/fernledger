import { describe, expect, it } from 'vitest'
import { formatAmount, formatBalance, formatDate, formatDateTime, formatDateAtTime, formatInstantDate, moneyLabel } from './format'

describe('formatDateAtTime (when a Report was generated)', () => {
  it.each([
    [new Date('2026-10-08T02:42:00.000Z'), 'Thu 8 Oct 2026 at 3:42 pm'], // summer time, UTC+13
    [new Date('2026-07-01T00:05:00.000Z'), 'Wed 1 Jul 2026 at 12:05 pm'], // winter time, UTC+12
    [new Date('2026-10-07T11:00:00.000Z'), 'Thu 8 Oct 2026 at 12:00 am'], // already the next day in NZ
    [new Date('2026-10-07T10:59:59.999Z'), 'Wed 7 Oct 2026 at 11:59 pm'],
    [Date.UTC(2026, 9, 8, 2, 42), 'Thu 8 Oct 2026 at 3:42 pm'], // a timestamp, as a query reports when its data arrived
  ])('writes the moment %s in NZ time as "%s", whatever the device\'s time zone', (instant, text) => {
    expect(formatDateAtTime(instant)).toBe(text)
  })

  it('refuses a moment that is not one, without echoing it', () => {
    expect(() => formatDateAtTime(Number.NaN)).toThrow(RangeError)
  })
})

describe('formatDateTime', () => {
  it.each([
    ['2026-10-08T02:42:00.000Z', 'Thu 8 Oct 2026, 3:42 pm'], // summer time, UTC+13
    ['2026-07-01T00:05:00.000Z', 'Wed 1 Jul 2026, 12:05 pm'], // winter time, UTC+12
    ['2026-10-07T11:00:00.000Z', 'Thu 8 Oct 2026, 12:00 am'], // already the next day in NZ
    ['2026-10-07T10:59:59.999Z', 'Wed 7 Oct 2026, 11:59 pm'],
  ])('writes the moment %s in NZ time as "%s"', (iso, text) => {
    expect(formatDateTime(iso)).toBe(text)
  })
})

describe('formatAmount (a Transaction: always signed)', () => {
  it('puts a real minus sign (U+2212, not a hyphen) before money out', () => {
    expect(formatAmount(-123456)).toBe('−$1,234.56')
    expect(formatAmount(-123456)).not.toContain('-')
  })
  it('puts a plus sign before money in', () => {
    expect(formatAmount(123456)).toBe('+$1,234.56')
  })
  it('shows zero without a sign', () => {
    expect(formatAmount(0)).toBe('$0.00')
  })
  it('keeps both decimals and groups thousands', () => {
    expect(formatAmount(5)).toBe('+$0.05')
    expect(formatAmount(-100)).toBe('−$1.00')
    expect(formatAmount(-123456789)).toBe('−$1,234,567.89')
  })
  it('is exact at the largest safe integer, where cents / 100 in floating point is not', () => {
    expect(formatAmount(Number.MAX_SAFE_INTEGER)).toBe('+$90,071,992,547,409.91')
    expect(formatAmount(-Number.MAX_SAFE_INTEGER)).toBe('−$90,071,992,547,409.91')
    expect(formatAmount(Number.MAX_SAFE_INTEGER - 1)).toBe('+$90,071,992,547,409.90')
    expect(formatAmount(-(2 ** 52) - 1)).toBe('−$45,035,996,273,704.97')
  })
  it('shows negative zero as $0.00, not −$0.00', () => {
    expect(formatAmount(-0)).toBe('$0.00')
    expect(formatBalance(-0)).toBe('$0.00')
  })
  it('refuses cents that are not whole numbers, without echoing the value', () => {
    for (const bad of [12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => formatAmount(bad)).toThrow(RangeError)
      expect(() => formatAmount(bad)).toThrow(/^[^\d]*$/)
    }
  })
})

describe('formatBalance (an Account balance: signed only when negative)', () => {
  it('leaves a positive balance unsigned', () => {
    expect(formatBalance(123456)).toBe('$1,234.56')
  })
  it('puts a real minus sign before an overdrawn balance', () => {
    expect(formatBalance(-5000)).toBe('−$50.00')
  })
  it('shows zero without a sign', () => {
    expect(formatBalance(0)).toBe('$0.00')
  })
})

describe('moneyLabel', () => {
  it('says Money in or Money out in plain words', () => {
    expect(moneyLabel(1)).toBe('Money in')
    expect(moneyLabel(-1)).toBe('Money out')
  })
  it('has no label for a zero amount', () => {
    expect(moneyLabel(0)).toBeNull()
  })
})

describe('formatDate (an NZ calendar date such as a Transaction date)', () => {
  it('reads like "Thu 8 Oct 2026": weekday, day, month, year, no comma, no leading zero', () => {
    expect(formatDate('2026-10-08')).toBe('Thu 8 Oct 2026')
    expect(formatDate('2026-01-01')).toBe('Thu 1 Jan 2026')
  })
  it('writes every month the NZ way, whatever the browser would say ("Sept", never "Sep")', () => {
    const months = Array.from({ length: 12 }, (_, i) => formatDate(`2026-${String(i + 1).padStart(2, '0')}-01`).split(' ')[2])
    expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'])
  })
  it('gives the right weekday across a leap day', () => {
    expect(formatDate('2028-02-29')).toBe('Tue 29 Feb 2028')
    expect(formatDate('2028-03-01')).toBe('Wed 1 Mar 2028')
  })
  it('does not move on days where the clocks change', () => {
    expect(formatDate('2026-09-27')).toBe('Sun 27 Sept 2026') // NZDT starts
    expect(formatDate('2026-04-05')).toBe('Sun 5 Apr 2026') // NZDT ends
  })
  it('refuses anything that is not a real YYYY-MM-DD date, without echoing it', () => {
    for (const bad of ['', '8 Oct 2026', '2026-10-8', '2026-02-30', '2026-13-01', '2026-10-08T00:00:00Z']) {
      expect(() => formatDate(bad)).toThrow(RangeError)
      expect(() => formatDate(bad)).toThrow(/^[^\d]*$/)
    }
  })
})

describe('formatInstantDate (a moment in time, shown as its NZ date)', () => {
  it('uses the New Zealand day, not the UTC day', () => {
    // 11:30 UTC on 7 Oct is 00:30 on 8 Oct in NZDT (UTC+13).
    expect(formatInstantDate(new Date('2026-10-07T11:30:00Z'))).toBe('Thu 8 Oct 2026')
  })
  it('turns over at NZ midnight in winter (NZST, UTC+12)', () => {
    expect(formatInstantDate(new Date('2026-06-14T11:59:59Z'))).toBe('Sun 14 Jun 2026')
    expect(formatInstantDate(new Date('2026-06-14T12:00:00Z'))).toBe('Mon 15 Jun 2026')
  })
  it('turns over at NZ midnight in summer (NZDT, UTC+13)', () => {
    expect(formatInstantDate(new Date('2026-12-24T10:59:59Z'))).toBe('Thu 24 Dec 2026')
    expect(formatInstantDate(new Date('2026-12-24T11:00:00Z'))).toBe('Fri 25 Dec 2026')
  })
  it('handles the day DST starts (27 Sept 2026: 02:00 NZST jumps to 03:00 NZDT)', () => {
    expect(formatInstantDate(new Date('2026-09-26T11:59:59Z'))).toBe('Sat 26 Sept 2026') // 23:59 NZST
    expect(formatInstantDate(new Date('2026-09-26T12:00:00Z'))).toBe('Sun 27 Sept 2026') // 00:00 NZST
    expect(formatInstantDate(new Date('2026-09-26T14:00:00Z'))).toBe('Sun 27 Sept 2026') // 03:00 NZDT
    expect(formatInstantDate(new Date('2026-09-27T10:59:59Z'))).toBe('Sun 27 Sept 2026') // 23:59 NZDT
    expect(formatInstantDate(new Date('2026-09-27T11:00:00Z'))).toBe('Mon 28 Sept 2026') // 00:00 NZDT
  })
  it('handles the day DST ends (5 Apr 2026: 03:00 NZDT falls back to 02:00 NZST)', () => {
    expect(formatInstantDate(new Date('2026-04-04T10:59:59Z'))).toBe('Sat 4 Apr 2026') // 23:59 NZDT
    expect(formatInstantDate(new Date('2026-04-04T11:00:00Z'))).toBe('Sun 5 Apr 2026') // 00:00 NZDT
    expect(formatInstantDate(new Date('2026-04-05T11:59:59Z'))).toBe('Sun 5 Apr 2026') // 23:59 NZST
    expect(formatInstantDate(new Date('2026-04-05T12:00:00Z'))).toBe('Mon 6 Apr 2026') // 00:00 NZST
  })
  it('crosses the new year in NZ before UTC does', () => {
    expect(formatInstantDate(new Date('2026-12-31T11:00:00Z'))).toBe('Fri 1 Jan 2027')
  })
  it('accepts epoch milliseconds', () => {
    expect(formatInstantDate(Date.UTC(2026, 9, 7, 11, 30))).toBe('Thu 8 Oct 2026')
  })
  it('refuses an invalid date', () => {
    expect(() => formatInstantDate(new Date('nope'))).toThrow(RangeError)
  })
})
