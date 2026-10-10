import { describe, expect, it } from 'vitest'
import type { BalancesReport } from '@/generated/api/report-balances'
import { closingLabel, describeDifference, differencesSummary, heldNotes, loadBalances, openingLabel, outlook, sourceOf } from './report-balances'

// What the balances Report says, as pure functions (src/lib/report-balances.ts); worker/report-balances.test.ts holds its numbers
// to the Account's balance history, and e2e/report-balances.spec.ts checks how it prints.

const report = (over: Partial<BalancesReport> = {}): BalancesReport => ({
  accountId: 1,
  from: '2026-07-01',
  to: '2026-10-31',
  anchor: { asOfDate: '2026-10-07', balanceCents: 12_300 },
  latestStatus: 'matched',
  held: { from: '2026-07-10', to: '2026-10-07' },
  opening: { balanceCents: 10_000, beforeFirst: true },
  rows: [{ date: '2026-10-07', balanceCents: 12_300, changeCents: 2300, bankCents: 12_300 }],
  closing: { date: '2026-10-07', balanceCents: 12_300 },
  checked: 0,
  differences: [],
  ...over,
})

describe('outlook', () => {
  it('has balances when the dates share some of the dates held', () => {
    expect(outlook(report())).toEqual({ kind: 'balances' })
  })

  it('says why there are none when no bank balance can be counted, in the words the Summary uses', () => {
    expect(outlook(report({ held: null, anchor: null, latestStatus: 'after-cutover', rows: [], opening: null, closing: null }))).toEqual({
      kind: 'no-balance',
      reason: 'The bank balance we have is after the Cutover Date',
    })
    expect(outlook(report({ held: null, anchor: null, latestStatus: 'file-ends-early', rows: [], opening: null, closing: null }))).toMatchObject({ reason: 'The file ended before its bank balance date' })
    expect(outlook(report({ held: null, anchor: null, latestStatus: null, rows: [], opening: null, closing: null }))).toMatchObject({ reason: 'No bank balance yet' })
  })

  it('says what is held when the dates end before it begins or begin after it ends', () => {
    expect(outlook(report({ to: '2026-07-09', rows: [], opening: null, closing: null }))).toEqual({ kind: 'before-held', heldFrom: '2026-07-10' })
    expect(outlook(report({ from: '2026-10-08', rows: [], opening: null, closing: null }))).toEqual({ kind: 'after-held', heldTo: '2026-10-07' })
  })
})

describe('openingLabel and closingLabel', () => {
  it('says the opening balance is from before the first Transaction held when the dates begin on or before it', () => {
    expect(openingLabel(report())).toBe('Before the first Transaction held, Fri 10 Jul 2026')
    expect(openingLabel(report({ from: '2026-07-10' }))).toBe('Before the first Transaction held, Fri 10 Jul 2026')
  })

  it('says it is the balance when the dates begin when they begin part way through', () => {
    expect(openingLabel(report({ from: '2026-08-20', opening: { balanceCents: 12_000, beforeFirst: false } }))).toBe('At the start of Thu 20 Aug 2026')
  })

  it('dates the closing balance by the last day it is for', () => {
    expect(closingLabel(report())).toBe('At the end of Wed 7 Oct 2026')
  })
})

describe('heldNotes', () => {
  it('says nothing when the dates are inside what is held', () => {
    expect(heldNotes(report({ from: '2026-08-01', to: '2026-09-30' }), null)).toEqual([])
  })

  it('says where the Transactions held begin and end when the dates run past them', () => {
    expect(heldNotes(report(), null)).toEqual(['No Transactions are held before Fri 10 Jul 2026.', 'No Transactions are held after Wed 7 Oct 2026, so the Report stops there.'])
  })

  it('adds where the rest of an Account with a Cutover Date will come from', () => {
    expect(heldNotes(report({ held: { from: '2026-07-10', to: '2026-08-31' } }), '2026-10-01')).toEqual([
      'No Transactions are held before Fri 10 Jul 2026.',
      'No Transactions are held after Mon 31 Aug 2026, so the Report stops there.',
      "From its Cutover Date, Thu 1 Oct 2026, this Account's Transactions will come from the bank link once syncing starts.",
    ])
  })

  it('leaves out a Cutover Date the dates do not reach', () => {
    expect(heldNotes(report({ to: '2026-09-30', held: { from: '2026-07-10', to: '2026-08-31' } }), '2026-10-01').join(' ')).not.toContain('Cutover Date')
  })

  it('has no notes for an Account with nothing held', () => {
    expect(heldNotes(report({ held: null }), '2026-10-01')).toEqual([])
  })
})

describe('sourceOf', () => {
  const line = { date: '2026-08-31', balanceCents: 12_000, changeCents: 0 }

  it('says a balance is calculated unless the bank gave one for that day', () => {
    expect(sourceOf({ ...line, bankCents: null })).toBe('Calculated from the Transactions')
  })

  it('says so when the bank gave the same balance', () => {
    expect(sourceOf({ ...line, bankCents: 12_000 })).toBe('Bank balance')
  })

  it('gives the bank’s own figure when it differs, without replacing the calculated one', () => {
    expect(sourceOf({ ...line, bankCents: 12_500 })).toBe('Calculated from the Transactions. The bank gave $125.00.')
    expect(sourceOf({ ...line, bankCents: -500 })).toBe('Calculated from the Transactions. The bank gave −$5.00.')
  })
})

describe('describeDifference', () => {
  it('uses the Balance Check’s own words, and says which bank balance found it', () => {
    expect(describeDifference({ asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: 400 })).toEqual({
      headline: 'Balance differs from bank by $4.00 since Mon 31 Aug 2026',
      found: 'Found in the bank balance of Wed 7 Oct 2026.',
      direction: "The bank's balance is higher than the Transactions add up to. Some money in may be missing, or some money out counted twice.",
    })
  })

  it('says which way a negative difference goes', () => {
    expect(describeDifference({ asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: -400 }).direction).toContain('lower than')
  })
})

describe('differencesSummary', () => {
  it('says there are none to list when a Balance Check covers the dates and found nothing', () => {
    expect(differencesSummary(report({ checked: 2 }))).toBe('No difference was found. Every Balance Check that covers these dates agrees with the bank.')
  })

  it('does not say the bank agrees when no Balance Check covers the dates', () => {
    expect(differencesSummary(report({ checked: 0 }))).toBe('No Balance Check covers these dates, so none could find a difference.')
  })

  it('has nothing to add when there are differences to list', () => {
    expect(differencesSummary(report({ checked: 1, differences: [{ asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: 400 }] }))).toBeNull()
  })
})

describe('loadBalances', () => {
  const accounts = [
    { id: 2, name: 'Example cheque', accountNumber: '99-9999-9999999-98', cutoverDate: null },
    { id: 1, name: 'Example savings', accountNumber: '99-9999-9999999-99', cutoverDate: '2026-10-01' },
  ]

  it('asks about each Account for the same dates and keeps them in the order given', async () => {
    const asked: unknown[] = []
    const sections = await loadBalances({
      accounts,
      from: '2026-07-01',
      to: '2026-10-31',
      fetchReport: async (request) => {
        asked.push(request)
        return report({ accountId: request.accountId })
      },
    })

    expect(sections.map((s) => [s.accountId, s.accountName, s.accountNumber, s.cutoverDate, s.report.accountId])).toEqual([
      [2, 'Example cheque', '99-9999-9999999-98', null, 2],
      [1, 'Example savings', '99-9999-9999999-99', '2026-10-01', 1],
    ])
    expect(asked).toEqual([
      { accountId: 2, from: '2026-07-01', to: '2026-10-31' },
      { accountId: 1, from: '2026-07-01', to: '2026-10-31' },
    ])
  })

  it('fails as a whole when any Account fails, so an Account that was not read never looks like one with no balances', async () => {
    await expect(
      loadBalances({
        accounts,
        from: '2026-07-01',
        to: '2026-10-31',
        fetchReport: async ({ accountId }) => {
          if (accountId === 1) throw new Error('Something went wrong')
          return report()
        },
      }),
    ).rejects.toThrow('Something went wrong')
  })
})
