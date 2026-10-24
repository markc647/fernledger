import { describe, expect, it } from 'vitest'
import type { BalancesReport } from '@/generated/api/report-balances'
import { closingLabel, describeDifference, differencesNote, differencesSummary, heldNotes, loadBalances, openingLabel, outlook, rowsDiffer, sourceOf } from './report-balances'

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
  changeCents: 2300,
  checks: { count: 0, coversFrom: null, coversTo: null },
  differences: [],
  ...over,
})

describe('outlook', () => {
  it('has balances when the dates share some of the dates held', () => {
    expect(outlook(report())).toEqual({ kind: 'balances' })
  })

  it('says why there are none when no bank balance can be counted, in the words the Summary uses', () => {
    expect(outlook(report({ held: null, anchor: null, latestStatus: 'after-cutover', rows: [], opening: null, closing: null, changeCents: null }))).toEqual({
      kind: 'no-balance',
      reason: 'The bank balance we have is after the Cutover Date',
    })
    expect(outlook(report({ held: null, anchor: null, latestStatus: 'file-ends-early', rows: [], opening: null, closing: null, changeCents: null }))).toMatchObject({ reason: 'The file ended before its bank balance date' })
    expect(outlook(report({ held: null, anchor: null, latestStatus: null, rows: [], opening: null, closing: null, changeCents: null }))).toMatchObject({ reason: 'No bank balance yet' })
  })

  it('says what is held when the dates end before it begins or begin after it ends', () => {
    expect(outlook(report({ to: '2026-07-09', rows: [], opening: null, closing: null, changeCents: null }))).toEqual({ kind: 'before-held', heldFrom: '2026-07-10' })
    expect(outlook(report({ from: '2026-10-08', rows: [], opening: null, closing: null, changeCents: null }))).toEqual({ kind: 'after-held', heldTo: '2026-10-07' })
  })
})

describe('openingLabel and closingLabel', () => {
  it('says the opening balance is from before the first date held when the dates begin on or before it', () => {
    expect(openingLabel(report())).toBe('Before the first date held, Fri 10 Jul 2026')
    expect(openingLabel(report({ from: '2026-07-10' }))).toBe('Before the first date held, Fri 10 Jul 2026')
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

  it('says the first and last date held when the dates run past them, for a date may be a bank balance’s and not a Transaction’s', () => {
    expect(heldNotes(report(), null)).toEqual([
      'The first date held for this Account is Fri 10 Jul 2026, so there are no balances before it.',
      'The last date held for this Account is Wed 7 Oct 2026, so the Report stops there.',
    ])
  })

  it('adds where the rest of an Account with a Cutover Date will come from', () => {
    expect(heldNotes(report({ held: { from: '2026-07-10', to: '2026-08-31' } }), '2026-10-01')).toEqual([
      'The first date held for this Account is Fri 10 Jul 2026, so there are no balances before it.',
      'The last date held for this Account is Mon 31 Aug 2026, so the Report stops there.',
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
  const row = { date: '2026-08-31', balanceCents: 12_000, changeCents: 0 }

  it('says a balance is calculated unless the bank gave one for that day', () => {
    expect(sourceOf({ ...row, bankCents: null })).toBe('Calculated from the Transactions')
  })

  it('says so when the bank gave the same balance', () => {
    expect(sourceOf({ ...row, bankCents: 12_000 })).toBe('Bank balance')
  })

  it('gives the bank’s own figure and the difference when they differ, without replacing the calculated one', () => {
    expect(sourceOf({ ...row, bankCents: 12_500 })).toBe("Calculated from the Transactions, $5.00 less than the bank's $125.00")
    expect(sourceOf({ ...row, bankCents: 11_700 })).toBe("Calculated from the Transactions, $3.00 more than the bank's $117.00")
    expect(sourceOf({ ...row, bankCents: -500 })).toBe("Calculated from the Transactions, $125.00 more than the bank's −$5.00")
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

describe('differencesNote', () => {
  const difference = { asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: 400 }

  it('says the balances before a difference carry it, because every balance is worked back from the latest bank balance', () => {
    expect(differencesNote(report({ differences: [difference] }))).toBe('Balances before Wed 7 Oct 2026 are worked back from the latest bank balance, so they carry this difference.')
  })

  it('says it of each date when there are several', () => {
    expect(differencesNote(report({ differences: [difference, { ...difference, asOfDate: '2026-09-30', since: '2026-08-31' }] }))).toBe(
      'Balances before each of these dates are worked back from the latest bank balance, so they carry the difference found there.',
    )
  })

  it('has nothing to say when there are no differences and every bank figure matches', () => {
    expect(differencesNote(report())).toBeNull()
  })

  it('explains a row that differs from the bank’s figure even when the difference is outside the dates, so none is listed', () => {
    // A difference found by a Balance Check that begins on or after the last of the dates is not listed, but the balances are still worked back from it.
    const differs = { rows: [{ date: '2026-08-31', balanceCents: 12_400, changeCents: 0, bankCents: 12_000 }] }
    expect(differencesNote(report(differs))).toBe(
      "Where a balance above differs from the bank's own figure, it is because every balance is worked back from the latest bank balance, and so carries any difference found after these dates, or a Transaction added after the bank gave its figure.",
    )
  })
})

describe('rowsDiffer', () => {
  const row = { date: '2026-08-31', balanceCents: 12_000, changeCents: 0 }

  it('is true when a figure the bank gave for a row’s day is not the row’s balance', () => {
    expect(rowsDiffer(report({ rows: [{ ...row, bankCents: 12_400 }] }))).toBe(true)
  })

  it('is false when the bank gave the same figure, or none', () => {
    expect(rowsDiffer(report({ rows: [{ ...row, bankCents: 12_000 }, { ...row, date: '2026-09-30', bankCents: null }] }))).toBe(false)
    expect(rowsDiffer(report({ rows: [] }))).toBe(false)
  })
})

describe('differencesSummary', () => {
  it('says how many Balance Checks covered the dates and what dates they span, which can be more than the Report’s, when they found nothing', () => {
    expect(differencesSummary(report({ checks: { count: 1, coversFrom: '2026-08-31', coversTo: '2026-10-07' } }))).toBe(
      'No difference was found. The one Balance Check that covers part or all of these dates agrees with the bank. It checks Mon 31 Aug 2026 to Wed 7 Oct 2026.',
    )
    expect(differencesSummary(report({ checks: { count: 2, coversFrom: '2026-08-31', coversTo: '2026-10-07' } }))).toBe(
      'No difference was found. The 2 Balance Checks that cover part or all of these dates agree with the bank. Together they check Mon 31 Aug 2026 to Wed 7 Oct 2026.',
    )
  })

  it('does not say the bank agrees while a row differs from the bank’s figure, though the checks inside the dates found nothing', () => {
    // 1 July to 31 August, in worker/report-balances.test.ts: 31 August's row is $4.00 off the bank's, but the check that found it begins that day.
    const rows = [{ date: '2026-08-31', balanceCents: 12_400, changeCents: 0, bankCents: 12_000 }]
    const one = differencesSummary(report({ rows, checks: { count: 1, coversFrom: '2026-07-31', coversTo: '2026-08-31' } }))
    expect(one).toBe('No difference was found in the one Balance Check that covers part or all of these dates, which checks Fri 31 Jul 2026 to Mon 31 Aug 2026.')
    const several = differencesSummary(report({ rows, checks: { count: 2, coversFrom: '2026-06-30', coversTo: '2026-08-31' } }))
    expect(several).toBe('No difference was found in the 2 Balance Checks that cover part or all of these dates, which together check Tue 30 Jun 2026 to Mon 31 Aug 2026.')
    expect(`${one} ${several}`).not.toContain('agree')
  })

  it('does not say the bank agrees when no Balance Check covers the dates', () => {
    expect(differencesSummary(report({ checks: { count: 0, coversFrom: null, coversTo: null } }))).toBe('No Balance Check covers these dates, so none could find a difference.')
  })

  it('has nothing to add when there are differences to list', () => {
    expect(
      differencesSummary(report({ checks: { count: 1, coversFrom: '2026-08-31', coversTo: '2026-10-07' }, differences: [{ asOfDate: '2026-10-07', since: '2026-08-31', differenceCents: 400 }] })),
    ).toBeNull()
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
