import { describe, expect, it } from 'vitest'
import type { LoanPage, LoanRow } from '@/generated/api/report-loans'
import { loadLoans, loanPerson, owedOf, owedSentence, owedWords, parseLoansSearch, type LoanPageRequest } from './report-loans'
import { REPORT_PAGE_SIZE } from './report-transactions'

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
    ['loans: Ben', 'Ben'],
    ['  Loan –   Carol Ann  ', 'Carol Ann'],
    ['Alice', 'Alice'],
    ['Alice loan', 'Alice loan'],
    ['Loanee', 'Loanee'],
    ['Loan Alice', 'Loan Alice'],
  ])('reads the person from %j as %j', (name, person) => {
    expect(loanPerson(name)).toBe(person)
  })

  it.each(['Loans', 'Loan', 'loans', 'Loan –', 'Loans:  ', ''])('reads no one from %j, as the starter Category, before it is renamed, names no one', (name) => {
    expect(loanPerson(name)).toBeNull()
  })
})

describe('owedSentence and owedWords', () => {
  it('says who owes whom, by the sign of what is owed', () => {
    expect(owedSentence('Alice', 30_000)).toBe('Alice owes $300.00')
    expect(owedSentence('Alice', -30_000)).toBe('Alice is owed $300.00')
    expect(owedSentence('Alice', 0)).toBe('Alice owes nothing')
    expect(owedWords('Alice', 30_000)).toBe('Alice owes')
    expect(owedWords('Alice', -30_000)).toBe('Alice is owed')
    expect(owedWords('Alice', 0)).toBe('Nothing owed')
  })

  it('writes the amount as an amount is written everywhere, with thousands and cents, and no sign', () => {
    expect(owedSentence('Ben', 123_456_789)).toBe('Ben owes $1,234,567.89')
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

  it('leaves out what is blank or not valid, rather than refusing it: all loans, from the first Transaction', () => {
    expect(parseLoansSearch({ category: '', from: '', to: '2026-10-31' })).toEqual({ to: '2026-10-31' })
    expect(parseLoansSearch({ category: 'x', from: '2026-02-30', to: '1999-12-31' })).toEqual({})
    expect(parseLoansSearch({ category: '0' })).toEqual({})
    expect(parseLoansSearch({ category: '1234567890' })).toEqual({})
    expect(parseLoansSearch({})).toEqual({})
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

  type Loan = { id: number; name: string; openingCents?: number; rows: LoanRow[] }
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
      return { category: { id: loan.id, name: loan.name }, openingCents: request.after === undefined ? (loan.openingCents ?? 0) : null, transactions, next: slice.length > request.limit && last ? `${last.date}:${last.id}` : null }
    }
    return { fetchPage, requests }
  }
  const alice = (rows: LoanRow[], openingCents?: number): Loan => ({ id: 1, name: 'Loan – Alice', rows, openingCents })

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
    const { fetchPage, requests } = api([alice([row(0, 10_000), row(1, -2000), row(2, -1000)], -40_000)])

    const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2026-10-31', fetchPage })

    expect(sections[0]!.openingOwedCents).toBe(40_000)
    expect(sections[0]!.lines.map((l) => l.owedAfterCents)).toEqual([30_000, 32_000, 33_000])
    expect(sections[0]!.owedCents).toBe(33_000)
    expect(requests[0]).toMatchObject({ from: '2026-08-01', to: '2026-10-31' })
  })

  it('is what was owed before, to the end, for a loan with nothing in the dates', async () => {
    const { fetchPage } = api([alice([], -40_000)])
    const { sections } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2026-10-31', fetchPage })
    expect(sections[0]).toMatchObject({ lines: [], status: 'complete', openingOwedCents: 40_000, owedCents: 40_000, moneyInCents: 0, moneyOutCents: 0 })
  })

  it('reads a loan a page at a time and carries the balance across pages, without asking for the opening balance again', async () => {
    const rows = Array.from({ length: REPORT_PAGE_SIZE * 2 + 5 }, (_, i) => row(i, i % 2 === 0 ? -1000 : 400))
    const { fetchPage, requests } = api([alice(rows, -2500)])

    const { sections, rowCount } = await loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: '2026-08-01', to: '2026-12-31', fetchPage })

    expect(requests.map((r) => [r.limit, r.after === undefined])).toEqual([[REPORT_PAGE_SIZE, true], [REPORT_PAGE_SIZE, false], [REPORT_PAGE_SIZE, false]])
    expect(rowCount).toBe(rows.length)
    const net = rows.reduce((sum, r) => sum + r.amountCents, 0)
    expect(sections[0]!.owedCents).toBe(owedOf(net - 2500))
    expect(sections[0]!.lines.at(-1)!.owedAfterCents).toBe(sections[0]!.owedCents)
    expect(sections[0]!.lines[REPORT_PAGE_SIZE]!.owedAfterCents).toBe(2500 + rows.slice(0, REPORT_PAGE_SIZE + 1).reduce((sum, r) => sum - r.amountCents, 0))
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

    it('is not capped when the loans hold exactly the cap, and asks one more only to find that out', async () => {
      const { fetchPage, requests } = data([3, 2, 0])
      const { sections, capped } = await loadLoans({ loans, from: undefined, to: '2026-10-31', fetchPage, cap: 5 })
      expect(capped).toBe(false)
      expect(sections.map((s) => s.status)).toEqual(['complete', 'complete', 'complete'])
      expect(requests.some((r) => r.limit === 1)).toBe(true)
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
  })

  it('fails the whole Report when a page fails, rather than show a loan as if it were all there', async () => {
    const fetchPage = async () => {
      throw new Error('Something went wrong')
    }
    await expect(loadLoans({ loans: [{ id: 1, name: 'Loan – Alice' }], from: undefined, to: '2026-10-31', fetchPage })).rejects.toThrow('Something went wrong')
  })
})
