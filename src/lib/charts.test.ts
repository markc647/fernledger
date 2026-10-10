import { describe, expect, it } from 'vitest'
import { barsOf, CHART_BARS, datesProblem, describeDates, NET_WORTH_ABOUT, NET_WORTH_RANGE_LABELS, NET_WORTH_RANGES, netWorthSummary, notCountedLine, PERIOD_LABELS, PERIODS, shorten, spendingSummary, stoppedEarly, stoppedEarlyLine, tooManyAccountsMessage } from './charts'

const category = (cents: number, id = cents) => ({ categoryId: id, name: `Category ${id}`, cents })

describe('PERIODS', () => {
  it('offers each period the Worker names, with words for it', () => {
    expect(PERIODS).toEqual(['this-month', 'last-month', 'past-3-months', 'past-12-months'])
    expect(PERIODS.map((period) => PERIOD_LABELS[period])).toEqual(['This month', 'Last month', 'Past 3 months', 'Past 12 months'])
  })
})

describe('barsOf', () => {
  it('draws the Categories that spent something, in the order given, and leaves out one that took in more than it paid out', () => {
    const { rows, bars, leftOut } = barsOf([category(5000), category(300), category(0, 3), category(-2500, 4)])

    expect(bars.map((c) => c.cents)).toEqual([5000, 300])
    expect(rows.map((c) => c.cents)).toEqual([5000, 300, -2500]) // a Category with nothing in it is not worth a row
    expect(leftOut).toBe(0)
  })

  it('stops at the most it can draw and says how many it left out', () => {
    const many = Array.from({ length: CHART_BARS + 3 }, (_, i) => category(10_000 - i))

    const { bars, leftOut } = barsOf(many)

    expect(bars).toHaveLength(CHART_BARS)
    expect(bars[0]).toBe(many[0])
    expect(leftOut).toBe(3)
  })

  it('draws nothing for no spending', () => {
    expect(barsOf([])).toEqual({ rows: [], bars: [], leftOut: 0 })
    expect(barsOf([category(-100)])).toEqual({ rows: [category(-100)], bars: [], leftOut: 0 }) // it is listed, and there is nothing to draw
  })
})

describe('shorten', () => {
  it('leaves a name that fits, and cuts one that does not with an ellipsis within the room', () => {
    expect(shorten('Groceries', 12)).toBe('Groceries')
    expect(shorten('Groceries', 9)).toBe('Groceries')
    expect(shorten('Health and medical', 10)).toBe('Health an…')
    expect(shorten('Health and medical', 10)).toHaveLength(10)
  })

  it('does not leave a space before the ellipsis, or split a character that takes two code units', () => {
    expect(shorten('Care fees', 6)).toBe('Care…')
    expect(shorten('🏠🏠🏠🏠🏠🏠', 3)).toBe('🏠🏠…')
  })

  it('keeps at least one character', () => {
    expect(shorten('Groceries', 0)).toBe('G…')
    expect(shorten('', 5)).toBe('')
  })
})

describe('describeDates', () => {
  it.each([
    ['2026-10-01', '2026-10-31', 'October 2026'],
    ['2026-02-01', '2026-02-28', 'February 2026'],
    ['2028-02-01', '2028-02-29', 'February 2028'], // a leap year
    ['2026-10-09', '2026-10-09', 'Fri 9 Oct 2026'],
    ['2026-08-01', '2026-10-31', 'Sat 1 Aug 2026 to Sat 31 Oct 2026'],
    ['2026-10-02', '2026-10-31', 'Fri 2 Oct 2026 to Sat 31 Oct 2026'],
    ['2026-10-01', '2026-10-30', 'Thu 1 Oct 2026 to Fri 30 Oct 2026'],
  ])('writes %s to %s as "%s"', (from, to, text) => {
    expect(describeDates(from, to)).toBe(text)
  })
})

describe('datesProblem', () => {
  it('is nothing for two real dates in order, or the same day', () => {
    expect(datesProblem('2026-10-01', '2026-10-31')).toBeNull()
    expect(datesProblem('2026-10-09', '2026-10-09')).toBeNull()
  })

  it.each([
    ['', '2026-10-31', 'from', 'Choose a From date.'],
    ['2026-10-01', '', 'to', 'Choose a To date.'],
    ['2026-02-30', '2026-10-31', 'from', 'The “From” date must be a real date from the year 2000 to 2100.'],
    ['2026-10-01', '0002-10-31', 'to', 'The “To” date must be a real date from the year 2000 to 2100.'],
    ['1999-12-31', '2026-10-31', 'from', 'The “From” date must be a real date from the year 2000 to 2100.'],
    ['2026-10-31', '2026-10-01', 'to', 'The “To” date is before the “From” date. Change one of them to see the chart.'],
  ])('marks %j and %j: the %s field, "%s"', (from, to, field, message) => {
    expect(datesProblem(from, to)).toEqual({ field, message })
  })
})

describe('what a screen reader is told', () => {
  it('says where net worth starts and ends, and where the figures are', () => {
    expect(
      netWorthSummary([
        { date: '2025-10-31', cents: 1_000_000 },
        { date: '2026-03-31', cents: 1_250_000 },
        { date: '2026-10-07', cents: 987_654 },
      ]),
    ).toBe('Line chart of net worth by month. It was $10,000.00 at the end of October 2025 and $9,876.54 on Wed 7 Oct 2026. The figures for every month are under “Show the figures”.')
  })

  it('says a single point as a sentence, and a negative balance with a real minus sign', () => {
    expect(netWorthSummary([{ date: '2026-10-07', cents: -50_000 }])).toBe('Net worth was −$500.00 on Wed 7 Oct 2026.')
  })

  it('says nothing for no points', () => {
    expect(netWorthSummary([])).toBe('')
  })

  it('says how many Categories the spending chart draws, for which dates', () => {
    expect(spendingSummary('October 2026', 3)).toBe('Bar chart of the 3 Categories that spent the most in October 2026. The figures for every Category are in the table below.')
    expect(spendingSummary('October 2026', 1)).toContain('the one Category that spent the most')
  })
})

describe('net worth\'s ranges', () => {
  it('offers each range the Worker knows, the Dashboard\'s first, with words for it', () => {
    expect(NET_WORTH_RANGES).toEqual(['24-months', '5-years', 'all'])
    expect(NET_WORTH_RANGES.map((range) => NET_WORTH_RANGE_LABELS[range])).toEqual(['Last 24 months', 'Last 5 years', 'All history'])
  })
})

describe('what net worth says about itself', () => {
  it('says it is the money in these Accounts, and that a loan to an untracked account is a fall or a rise, without naming a Report', () => {
    expect(NET_WORTH_ABOUT[0]).toContain("Only the money in these Accounts")
    expect(NET_WORTH_ABOUT[0]).toContain("A loan to or from someone whose account isn't tracked shows as a fall or a rise.")
    expect(NET_WORTH_ABOUT.join(' ')).not.toMatch(/Loans Report/)
  })

  it('says the months before an Account\'s history are an estimate, and that after its last Transaction it keeps its last balance', () => {
    expect(NET_WORTH_ABOUT[1]).toContain('are an estimate')
    expect(NET_WORTH_ABOUT[1]).toContain('keeps its last balance')
  })

  it('does not say "we"', () => {
    expect([...NET_WORTH_ABOUT, tooManyAccountsMessage(52, 49)].join(' ')).not.toMatch(/\bwe\b/i)
  })

  it('says the most Accounts it can draw in plain language, with how many there are', () => {
    expect(tooManyAccountsMessage(52, 49)).toBe("Net worth can't be drawn for this many Accounts. It works for up to 49, and this Fernledger has 52, so it shows nothing rather than a total that leaves some out.")
  })

  it('says why an Account is left out in the Summary\'s own words, and what the Admin can do', () => {
    expect(notCountedLine({ accountId: 1, accountName: 'Example savings', latestStatus: 'file-ends-early' })).toBe(
      'Example savings: The file ended before its bank balance date. The Admin can import a file that runs to its balance date.',
    )
    expect(notCountedLine({ accountId: 2, accountName: 'Example credit card', latestStatus: null })).toBe('Example credit card: No bank balance yet. The Admin can import a bank file to give it one.')
  })

  it('finds the Accounts whose last Transaction is in an earlier month than the line\'s end, and says so with what to do', () => {
    const counted = [
      { accountId: 1, accountName: 'Example everyday', lastDate: '2026-10-07' },
      { accountId: 2, accountName: 'Example savings', lastDate: '2026-07-20' },
      { accountId: 3, accountName: 'Example cheque', lastDate: '2026-10-01' },
    ]

    const early = stoppedEarly(counted, [{ date: '2026-07-31' }, { date: '2026-10-07' }])

    expect(early.map((a) => a.accountName)).toEqual(['Example savings'])
    expect(stoppedEarlyLine(early[0]!)).toBe('Example savings: its last Transaction is Mon 20 Jul 2026, and its balance stays the same after that. The Admin can import a newer bank file to bring it up to date.')
    expect(stoppedEarly(counted, [])).toEqual([])
  })
})
