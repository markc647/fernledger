import { describe, expect, it } from 'vitest'
import { DIFFERENCE, DIFFERENCE_SENTENCE, MAX_INCOME_MONTHS, monthNote, partOfMonth, tooManyIncomeMonths, uncategorisedNotice } from './income-vs-spending'

describe('partOfMonth', () => {
  it('is null for a month the dates cover in full, however many months they cover', () => {
    expect(partOfMonth('2026-10', '2026-10-01', '2026-10-31')).toBeNull()
    expect(partOfMonth('2026-10', '2026-09-15', '2026-11-15')).toBeNull() // in the middle
    expect(partOfMonth('2028-02', '2028-02-01', '2028-02-29')).toBeNull() // the 29th of a leap year is the last day
    expect(partOfMonth('2027-02', '2027-02-01', '2027-02-28')).toBeNull() // and the 28th of any other year
  })

  it('names the dates counted in a month the range starts or ends part way through', () => {
    expect(partOfMonth('2026-10', '2026-10-15', '2026-12-31')).toBe('Thu 15 Oct 2026 to Sat 31 Oct 2026')
    expect(partOfMonth('2026-12', '2026-10-01', '2026-12-10')).toBe('Tue 1 Dec 2026 to Thu 10 Dec 2026')
    expect(partOfMonth('2026-10', '2026-10-05', '2026-10-20')).toBe('Mon 5 Oct 2026 to Tue 20 Oct 2026') // both ends in one month
  })

  it('names one date, not a range, when one day is counted', () => {
    expect(partOfMonth('2026-10', '2026-10-31', '2026-10-31')).toBe('Sat 31 Oct 2026')
    expect(partOfMonth('2028-02', '2028-02-29', '2028-03-31')).toBe('Tue 29 Feb 2028')
  })
})

describe('tooManyIncomeMonths', () => {
  it('lets the dates touch up to 120 months, 10 years, counting a part month as a month', () => {
    expect(MAX_INCOME_MONTHS).toBe(120)
    expect(tooManyIncomeMonths('2016-01-01', '2025-12-31')).toBeNull()
    expect(tooManyIncomeMonths('2016-01-31', '2025-12-01')).toBeNull()
    expect(tooManyIncomeMonths('2016-01-01', '2026-01-01')).toBe('An Income vs spending by month Report covers at most 120 months (10 years). Choose dates that touch 120 months or fewer.')
    expect(tooManyIncomeMonths('2015-12-31', '2025-12-01')).not.toBeNull() // 121 months, though only 119 whole months and a bit
  })
})

describe('monthNote', () => {
  it('says what a reader needs of a month that is not over, and nothing of one that is', () => {
    expect(monthNote('ended')).toBeNull()
    expect(monthNote('under-way')).toBe('This month is not over yet, so these are the figures so far.')
    expect(monthNote('not-begun')).toBe('This month has not begun, so there is nothing to show yet.')
  })
})

describe('uncategorisedNotice', () => {
  it('says how much money in has no Category, what that does to Spending and Income, and that the Difference is unaffected', () => {
    expect(uncategorisedNotice(300)).toBe(
      "$3.00 of money in has no Category, so it comes off Spending and isn't counted as Income. Give it an Income Category to count it. The Difference is unaffected.",
    )
    expect(uncategorisedNotice(123_456_789)).toMatch(/^\$1,234,567\.89 of money in has no Category/)
  })

  it('is nothing when none of the money in is Uncategorised', () => {
    expect(uncategorisedNotice(0)).toBeNull()
  })
})

describe('what the Difference is called', () => {
  it('is defined where it is a heading and where it is a sentence', () => {
    expect(DIFFERENCE).toBe('Difference (income less spending)')
    expect(DIFFERENCE_SENTENCE).toBe('The Difference is income less spending.')
  })
})
