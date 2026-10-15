import { describe, expect, it } from 'vitest'
import type { LoanPage, LoanRow } from '@/generated/api/report-loans'
import { isUnused, loadLoans, LOANS_PAGE_SIZE, LOANS_ROW_CAP, loanPerson, owedOf, owedSentence, owedWords, parseLoansSearch, totalLoans, type LoanPageRequest, type LoanSection } from './report-loans'

// What the Loans Report says and adds up, as pure functions (src/lib/report-loans.ts); worker/report-loans.test.ts holds which Transactions are loans to the
// shared spending definition, and e2e/report-loans.spec.ts checks how it prints.

describe('owedOf', () => {
  it('is what is owed: positive after money went out, negative after money came in, and never negative zero', () => {
    expect(owedOf(-50_000)).toBe(50_000)
    expect(owedOf(20_000)).toBe(-20_000)
    expect(Object.is(owedOf(0), 0)).toBe(true)
  })
})

describe('loanPerson', () => {
  it.each([
    ['Loan – Alice', 'Alice'],
    ['Loan - Alice', 'Alice'],
    ['Loan — Alice', 'Alice'],
    ['Loan ‒ Alice', 'Alice'], // a figure dash, U+2012
    ['Loan − Alice', 'Alice'], // a minus sign, U+2212
    ['Loan ‐ Alice', 'Alice'], // a Unicode hyphen, U+2010
    ['Loan-Alice', 'Alice'],
    ['loans: Ben', 'Ben'],
    ['  Loan –   Carol Ann  ', 'Carol Ann'],
    ['Loan Alice', 'Alice'],
    ['Loans to Alice', 'Alice'],
    ['Loan to Alice', 'Alice'],
    ['Loan from Ben', 'Ben'],
    ['LOAN – ALICE', 'ALICE'],
    ['Loan Tomas', 'Tomas'], // "To" is not "to Mas"
    ['Alice', 'Alice'],
    ['Alice loan', 'Alice loan'],
    ["Alice's car", "Alice's car"],
    ['Loanee', 'Loanee'],
    ['Loansharks', 'Loansharks'],
  ])('reads the person from %j as %j', (name, person) => {
    expect(loanPerson(name)).toBe(person)
  })

  it.each(['Loans', 'Loan', 'loans', 'Loan –', 'Loan −', 'Loans:  ', 'Loan  ', ''])('reads no one from %j, as the starter Category, before it is renamed, names no one', (name) => {
    expect(loanPerson(name)).toBeNull()
  })
})

describe('owedSentence and owedWords', () => {
  it('says who owes whom, by the sign of what is owed, and that the household side is the Accounts', () => {
    expect(owedSentence('Alice', 30_000)).toBe('Alice owes $300.00 to the Accounts')
    expect(owedSentence('Alice', -30_000)).toBe('Alice is owed $300.00')
    expect(owedSentence('Alice', 0)).toBe('Alice owes nothing')
    expect(owedWords('Alice', 30_000)).toBe('Alice owes')
    expect(owedWords('Alice', -30_000)).toBe('Alice is owed')
    expect(owedWords('Alice', 0)).toBe('Nothing owed')
  })

  it('writes the amount as an amount is written everywhere, with thousands and cents, and no sign', () => {
    expect(owedSentence('Ben', 123_456_789)).toBe('Ben owes $1,234,567.89 to the Accounts')
    expect(owedSentence('Ben', -5)).toBe('Ben is owed $0.05')
  })

  it('says the Accounts are owed, or owe, for a Category that names no one, and never uses "we"', () => {
    expect(owedSentence(null, 30_000)).toBe('$300.00 is owed to the Accounts')
    expect(owedSentence(null, -30_000)).toBe('$300.00 is owed by the Accounts')
    expect(owedSentence(null, 0)).toBe('Nothing is owed')
    expect(owedWords(null, 30_000)).toBe('Owed to the Accounts')
    expect(owedWords(null, -30_000)).toBe('Owed by the Accounts')
    for (const cents of [30_000, -30_000, 0]) for (const person of ['Alice', null]) expect(`${owedSentence(person, cents)} ${owedWords(person, cents)}`).not.toMatch(/\bwe\b|\bus\b/i)
  })
})

describe('parseLoansSearch', () => {
  it('reads the Category and the dates', () => {
    expect(parseLoansSearch({ category: '3', from: '2026-01-01', to: '2026-10-31' })).toEqual({ category: 3, from: '2026-01-01', to: '2026-10-31' })
    expect(parseLoansSearch({ category: 3, to: '2026-10-31' })).toEqual({ category: 3, to: '2026-10-31' })
  })

  it('leaves out what is blank, and a date that is not valid, rather than refusing it: all loans, from the first Transaction (every key is there, as undefined: the router lays them over the address)', () => {
    expect(parseLoansSearch({ category: '', from: '', to: '2026-10-31' })).toStrictEqual({ category: undefined, from: undefined, to: '2026-10-31' })
    expect(parseLoansSearch({ from: '2026-02-30', to: '1999-12-31' })).toStrictEqual({ category: undefined, from: undefined, to: undefined })
    expect(parseLoansSearch({})).toStrictEqual({ category: undefined, from: undefined, to: undefined })
  })

  it('makes a Category that is named but is not valid one that does not exist, so the page says so and does not list every loan', () => {
    for (const named of ['x', 'abc', '0', 0, -1, '1234567890']) expect(parseLoansSearch({ category: named }).category, String(named)).toBe(0)
  })
})

describe('the page and the cap', () => {
  it('asks for larger pages and a lower cap than the Transaction listing, because every page of a loan re-reads the loan (ADR 0004)', () => {
    expect(LOANS_PAGE_SIZE).toBe(1000)
    expect(LOANS_ROW_CAP).toBe(5000)
  })
})

describe('loadLoans', () => {
  let n = 0
  /** A Transaction of a loan, dated 2026-08-01 plus `day` days. */
  const row = (day: number, amountCents: number, over: Partial<LoanRow> = {}): LoanRow => {
    n += 1
    return {
      id: n,
      date: new Date(Date.UTC(2026, 7, 1 + day)).toISOString().slice(0, 10),
      description: `EXAMPLE ${n}`,
      amountCents,
      accountName: 'Example everyday',
      note: null,
      ...over,
    }
  }

  type Loan = { id: number; name: string; openingCents?: number; openingCount?: number; rows: LoanRow[] }
  /** The Worker's pages, standing in for the API: the loan's rows in order, `limit` at a time after a cursor, with the opening balance on the first page only. */
  function api(loans: Loan[]) {
    const requests: LoanPageRequest[] = []
    const fetchPage = async (request: LoanPageRequest): Promise<LoanPage> => {
      requests.push(request)
      const loan = loans.find((l) => l.id === request.categoryId)!
      const start = request.after === undefined ? 0 : loan.rows.findIndex((r) => `${r.date}:${r.id}` === request.after) + 1
      const slice = loan.rows.slice(start, start + request.limit + 1)
      const transactions = slice.slice(0, request.limit)
      const last = transactions.at(-1)
      return {
        category: { id: loan.id, name: loan.name },
        opening: request.after === undefined ? { cents: loan.openingCents ?? 0, count: loan.openingCount ?? 0 } : null,
        transactions,
        next: slice.length > request.limit && last ? `${last.date}:${last.id}` : null,
      }
    }
    return { fetchPage, requests }
  }
  const alice = (rows: LoanRow[], openingCents?: number, openingCount?: number): Loan => ({ id: 1, name: 'Loan – Alice', rows, openingCents, openingCount })

  it('adds up a loan: what is owed after each Transaction, money out and in apart, and what is owed at the end', async () => {
    const { fetchPage } = api([alice([row(0, -50_000), row(5, 20_000), row(9, 10_000)])])

    const { sections, rowCount, capped } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: undefined, to: '2026-10-31', fetchPage })

    expect(sections).toHaveLength(1)
    const section = sections[0]!
    expect(section.lines.map((l) => l.owedAfterCents)).toEqual([50_000, 30_000, 20_000])
    expect(section.moneyOutCents).toBe(-50_000)
    expect(section.moneyInCents).toBe(30_000)
    expect(section.owedCents).toBe(20_000)
    expect(section.openingOwedCents).toBe(0)
    expect(section.status).toBe('complete')
    expect(rowCount).toBe(3)
    expect(capped).toBe(false)
  })

  it('turns to what the household owes when more came in than went out', async () => {
    const { fetchPage } = api([alice([row(0, 30_000), row(1, -10_000)])])
    const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: undefined, to: '2026-10-31', fetchPage })
    expect(sections[0]!.lines.map((l) => l.owedAfterCents)).toEqual([-30_000, -20_000])
    expect(sections[0]!.owedCents).toBe(-20_000)
  })

  it('starts the running balance from what was owed before the start date, which is in the first page only', async () => {
    const { fetchPage, requests } = api([alice([row(0, 10_000), row(1, -2000), row(2, -1000)], -40_000, 2)])

    const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2026-10-31', fetchPage })

    expect(sections[0]!.openingOwedCents).toBe(40_000)
    expect(sections[0]!.openingCount).toBe(2)
    expect(sections[0]!.lines.map((l) => l.owedAfterCents)).toEqual([30_000, 32_000, 33_000])
    expect(sections[0]!.owedCents).toBe(33_000)
    expect(requests[0]).toMatchObject({ from: '2026-08-01', to: '2026-10-31' })
  })

  it('is what was owed before, to the end, for a loan with nothing in the dates', async () => {
    const { fetchPage } = api([alice([], -40_000, 1)])
    const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2026-10-31', fetchPage })
    expect(sections[0]).toMatchObject({ lines: [], status: 'complete', openingOwedCents: 40_000, owedCents: 40_000, moneyInCents: 0, moneyOutCents: 0 })
  })

  it('reads a loan a page at a time and carries the balance across pages, without asking for the opening balance again', async () => {
    const rows = Array.from({ length: LOANS_PAGE_SIZE * 2 + 5 }, (_, i) => row(i, i % 2 === 0 ? -1000 : 400))
    const { fetchPage, requests } = api([alice(rows, -2500, 3)])

    const { sections, rowCount } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2030-12-31', fetchPage })

    expect(requests.map((r) => [r.limit, r.after === undefined])).toEqual([[LOANS_PAGE_SIZE, true], [LOANS_PAGE_SIZE, false], [LOANS_PAGE_SIZE, false]])
    expect(rowCount).toBe(rows.length)
    const net = rows.reduce((sum, r) => sum + r.amountCents, 0)
    expect(sections[0]!.owedCents).toBe(owedOf(net - 2500))
    expect(sections[0]!.lines.at(-1)!.owedAfterCents).toBe(sections[0]!.owedCents)
    expect(sections[0]!.lines[LOANS_PAGE_SIZE]!.owedAfterCents).toBe(2500 + rows.slice(0, LOANS_PAGE_SIZE + 1).reduce((sum, r) => sum - r.amountCents, 0))
  })

  it('lists each loan on its own, in the order given, with its own figures', async () => {
    const { fetchPage } = api([alice([row(0, -50_000)]), { id: 2, name: 'Loan – Ben', rows: [row(1, -30_000), row(2, 30_000)] }, { id: 3, name: 'Loan – Carol', rows: [] }])

    const { sections } = await loadLoans({
      loans: [{ id: 1, name: 'Loan – Alice' }, { id: 2, name: 'Loan – Ben' }, { id: 3, name: 'Loan – Carol' }],
      from: undefined,
      to: '2026-10-31',
      fetchPage,
    })

    expect(sections.map((s) => [s.name, s.owedCents, s.lines.length])).toEqual([['Loan – Alice', 50_000, 1], ['Loan – Ben', 0, 2], ['Loan – Carol', 0, 0]])
  })

  it('asks about nothing when there are no loans', async () => {
    const { fetchPage, requests } = api([])
    expect(await loadLoans({ loans: [], from: undefined, to: '2026-10-31', fetchPage })).toEqual({ sections: [], rowCount: 0, capped: false })
    expect(requests).toEqual([])
  })

  describe('the cap', () => {
    const loans = [{ id: 1, name: 'Loan – Alice' }, { id: 2, name: 'Loan – Ben' }, { id: 3, name: 'Loan – Carol' }]
    const data = (counts: number[]) => api(counts.map((count, i) => ({ id: i + 1, name: loans[i]!.name, rows: Array.from({ length: count }, (_, k) => row(k, -100)) })))

    it('stops in the middle of a loan, says it is partly listed with no amount owed at the end, and does not ask about the loans after it', async () => {
      const { fetchPage, requests } = data([3, 6, 2])

      const { sections, rowCount, capped } = await loadLoans({ loans, from: undefined, to: '2026-10-31', fetchPage, cap: 5 })

      expect(capped).toBe(true)
      expect(rowCount).toBe(5)
      expect(sections.map((s) => [s.status, s.lines.length, s.owedCents])).toEqual([['complete', 3, 300], ['partial', 2, null], ['not-listed', 0, null]])
      expect(sections[1]!.lines.map((l) => l.owedAfterCents)).toEqual([100, 200]) // what is listed is right; only the end is not known
      expect(requests.filter((r) => r.categoryId === 3)).toEqual([])
    })

    it.each([
      ['no start date', undefined],
      ['a start date', '2026-08-01'],
    ])('is not capped when the loans hold exactly the cap, with %s, and asks one more only to find that out', async (_what, from) => {
      const { fetchPage, requests } = data([3, 2, 0])
      const { sections, capped } = await loadLoans({ loans, from, to: '2026-10-31', fetchPage, cap: 5 })
      expect(capped).toBe(false)
      expect(sections.map((s) => s.status)).toEqual(['complete', 'complete', 'complete'])
      expect(requests.some((r) => r.limit === 1)).toBe(true)
    })

    it('keeps what a probe that finds nothing says of a loan: one owed from before the start date, with nothing in the dates, is not "never used" because the cap was just filled', async () => {
      // The first loan fills the cap exactly. The second has nothing in the dates but is owed $400.00 from before them, which its probe, one Transaction at most, carries.
      const { fetchPage, requests } = api([alice([row(0, -100), row(1, -100), row(2, -100)]), { id: 2, name: 'Loan – Ben', rows: [], openingCents: -40_000, openingCount: 1 }])

      const { sections, rowCount, capped } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }, { id: 2, name: 'Loan – Ben' }], from: '2026-08-01', to: '2026-10-31', fetchPage, cap: 3 })

      expect(capped).toBe(false)
      expect(rowCount).toBe(3) // the probe added nothing to the count
      expect(sections[1]).toMatchObject({ status: 'complete', lines: [], openingOwedCents: 40_000, openingCount: 1, owedCents: 40_000 })
      expect(isUnused(sections[1]!)).toBe(false)
      expect(requests.filter((r) => r.categoryId === 2)).toEqual([{ categoryId: 2, from: '2026-08-01', to: '2026-10-31', after: undefined, limit: 1 }]) // one request, the probe: nothing is asked twice
    })

    it('still calls a loan that is never used unused when its probe is all that was asked of it', async () => {
      const { fetchPage } = api([alice([row(0, -100), row(1, -100), row(2, -100)]), { id: 2, name: 'Loan – Ben', rows: [] }])
      const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }, { id: 2, name: 'Loan – Ben' }], from: '2026-08-01', to: '2026-10-31', fetchPage, cap: 3 })
      expect(sections[1]).toMatchObject({ status: 'complete', openingOwedCents: 0, openingCount: 0, owedCents: 0 })
      expect(isUnused(sections[1]!)).toBe(true)
    })

    it('calls a loan that starts where the cap fell not listed, not empty, and the loans after it too', async () => {
      const { fetchPage } = data([5, 4, 1])
      const { sections, capped } = await loadLoans({ loans, from: undefined, to: '2026-10-31', fetchPage, cap: 5 })
      expect(capped).toBe(true)
      expect(sections.map((s) => [s.status, s.lines.length, s.owedCents])).toEqual([['complete', 5, 500], ['not-listed', 0, null], ['not-listed', 0, null]])
    })

    it('goes past a loan with nothing in it when the cap has fallen, to look for the next that has something', async () => {
      const { fetchPage } = data([5, 0, 1])
      const { sections, capped } = await loadLoans({ loans, from: undefined, to: '2026-10-31', fetchPage, cap: 5 })
      expect(capped).toBe(true)
      expect(sections.map((s) => s.status)).toEqual(['complete', 'complete', 'not-listed'])
    })

    it('stops at 5,000 Transactions by default', async () => {
      const { fetchPage } = data([LOANS_ROW_CAP + 1])
      const { sections, rowCount, capped } = await loadLoans({ loans: [loans[0]!], from: undefined, to: '2030-12-31', fetchPage })
      expect(rowCount).toBe(LOANS_ROW_CAP)
      expect(capped).toBe(true)
      expect(sections[0]).toMatchObject({ status: 'partial', owedCents: null })
    })
  })

  it('fails the whole Report when a page fails, rather than show a loan as if it were all there', async () => {
    const fetchPage = async () => {
      throw new Error('Something went wrong')
    }
    await expect(loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: undefined, to: '2026-10-31', fetchPage })).rejects.toThrow('Something went wrong')
  })

  describe('isUnused and totalLoans', () => {
    const section = (over: Partial<LoanSection>): LoanSection => ({
      categoryId: 1,
      name: 'Loan – Alice',
      status: 'complete',
      openingOwedCents: 0,
      openingCount: 0,
      lines: [],
      moneyInCents: 0,
      moneyOutCents: 0,
      owedCents: 0,
      ...over,
    })

    it('calls a loan unused only when all of it was read and nothing is in the dates or before them: a loan that was paid off is not unused', async () => {
      const { fetchPage } = api([alice([]), { id: 2, name: 'Loan – Ben', rows: [], openingCents: 0, openingCount: 2 }, { id: 3, name: 'Loan – Carol', rows: [row(0, -100), row(1, 100)] }])
      const { sections } = await loadLoans({
        loans: [{ id: 1, name: 'Loan – Alice' }, { id: 2, name: 'Loan – Ben' }, { id: 3, name: 'Loan – Carol' }],
        from: '2026-08-01',
        to: '2026-10-31',
        fetchPage,
      })
      expect(sections.map(isUnused)).toEqual([true, false, false])
      expect(isUnused(section({ status: 'not-listed' }))).toBe(false)
      expect(isUnused(section({ status: 'partial' }))).toBe(false)
    })

    it('adds what the Accounts are owed and what they owe apart, and never nets one against the other', () => {
      const totals = totalLoans([section({ owedCents: 30_000 }), section({ owedCents: 5000 }), section({ owedCents: -20_000 }), section({ owedCents: -1 }), section({ owedCents: 0 })])
      expect(totals).toEqual({ owedToCents: 35_000, owedByCents: 20_001, notWorkedOut: 0 })
    })

    it('leaves a loan the cap stopped out of both totals, and counts it', () => {
      expect(totalLoans([section({ owedCents: 30_000 }), section({ status: 'partial', owedCents: null }), section({ status: 'not-listed', owedCents: null })])).toEqual({
        owedToCents: 30_000,
        owedByCents: 0,
        notWorkedOut: 2,
      })
    })
  })
})
