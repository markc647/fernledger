import { describe, expect, it } from 'vitest'
import { addMonths, budgetStatus, capNotice, changeLine, laterChanges, monthChoices, savedMessage, spentText } from './budgets'

describe('budgetStatus', () => {
  it('is under Budget, with what is left, while less than the Budget has been spent', () => {
    expect(budgetStatus(80_000, 55_050)).toEqual({ kind: 'under', tone: 'success', words: 'Under Budget', detail: '$249.50 left' })
    expect(budgetStatus(80_000, 0)).toMatchObject({ kind: 'under', detail: '$800.00 left' })
    expect(budgetStatus(80_000, 79_999)).toMatchObject({ kind: 'under', detail: '$0.01 left' })
  })

  it('is on Budget when exactly the Budget has been spent, which is not over', () => {
    expect(budgetStatus(80_000, 80_000)).toEqual({ kind: 'on', tone: 'neutral', words: 'On Budget', detail: 'Nothing left' })
  })

  it('is over Budget, with by how much, once more than the Budget has been spent', () => {
    expect(budgetStatus(9_000, 9_500)).toEqual({ kind: 'over', tone: 'danger', words: 'Over Budget', detail: '$5.00 over' })
    expect(budgetStatus(80_000, 80_001)).toMatchObject({ kind: 'over', detail: '$0.01 over' })
  })

  it('counts money back (spent below zero) as all of the Budget left', () => {
    expect(budgetStatus(80_000, -1_500)).toMatchObject({ kind: 'under', detail: '$815.00 left' })
  })

  it('reads big amounts with thousands separators', () => {
    expect(budgetStatus(123_456_789, 0).detail).toBe('$1,234,567.89 left')
  })
})

describe('spentText', () => {
  it('writes what was spent in dollars, and money back as money back rather than as a negative spend', () => {
    expect(spentText(5_550)).toBe('$55.50')
    expect(spentText(0)).toBe('$0.00')
    expect(spentText(-1_500)).toBe('$15.00 back')
    expect(spentText(-123_456_789)).toBe('$1,234,567.89 back')
  })
})

describe('laterChanges', () => {
  it('keeps the changes that begin after the month, which is where a Budget set from it stops', () => {
    const changes = [{ effectiveFrom: '2026-08' }, { effectiveFrom: '2026-10' }, { effectiveFrom: '2026-12' }, { effectiveFrom: '2027-03' }]

    expect(laterChanges(changes, '2026-10')).toEqual([{ effectiveFrom: '2026-12' }, { effectiveFrom: '2027-03' }])
    expect(laterChanges(changes, '2027-03')).toEqual([])
    expect(laterChanges(changes, '2020-01')).toEqual(changes)
    expect(laterChanges([], '2026-10')).toEqual([])
  })
})

describe('capNotice', () => {
  it('says nothing while there is plenty of room', () => {
    expect(capNotice(0, 600)).toBeNull()
    expect(capNotice(539, 600)).toBeNull()
  })

  it('says how many are used, and that none can be removed, once the history is nearly full', () => {
    expect(capNotice(540, 600)).toBe('Fernledger keeps at most 600 Budget changes, for good, and none can be removed. 540 are used.')
    expect(capNotice(599, 600)).toContain('599 are used')
  })

  it('says when it is full, and that a month with a change can still be replaced', () => {
    expect(capNotice(600, 600)).toBe('Fernledger keeps at most 600 Budget changes, for good, and all 600 are used. A month that already has a change can still be replaced.')
  })
})

describe('addMonths', () => {
  it.each([
    ['2026-10', 0, '2026-10'],
    ['2026-10', 1, '2026-11'],
    ['2026-10', 3, '2027-01'],
    ['2026-12', 1, '2027-01'],
    ['2026-10', 24, '2028-10'],
    ['2026-10', -1, '2026-09'],
    ['2026-01', -1, '2025-12'],
    ['2026-10', -12, '2025-10'],
    ['2026-03', -15, '2024-12'],
  ])('%s plus %i months is %s', (month, by, expected) => {
    expect(addMonths(month, by)).toBe(expected)
  })
})

describe('monthChoices', () => {
  it('lists the months a Budget can start from, a year back to two years ahead, oldest first, each written in full', () => {
    const choices = monthChoices('2026-10')

    expect(choices).toHaveLength(37)
    expect(choices[0]).toEqual({ value: '2025-10', label: 'October 2025' })
    expect(choices[12]).toEqual({ value: '2026-10', label: 'October 2026' })
    expect(choices.at(-1)).toEqual({ value: '2028-10', label: 'October 2028' })
    expect(new Set(choices.map((c) => c.value)).size).toBe(37)
  })
})

describe('changeLine', () => {
  it('says what a Budget is from a month, or that it ends', () => {
    expect(changeLine({ effectiveFrom: '2026-08', amountCents: 80_000 })).toBe('From August 2026: $800.00 a month')
    expect(changeLine({ effectiveFrom: '2026-12', amountCents: null })).toBe('From December 2026: no Budget')
  })
})

describe('savedMessage', () => {
  it('says a Budget was set, with the month in words', () => {
    expect(savedMessage('Groceries', { effectiveFrom: '2026-10', amountCents: 80_050, changed: true })).toBe('Groceries now has a Budget of $800.50 a month from October 2026.')
  })

  it('says a Budget ended', () => {
    expect(savedMessage('Groceries', { effectiveFrom: '2026-12', amountCents: null, changed: true })).toBe('Ended the Budget for Groceries from December 2026.')
  })

  it('says nothing changed, and why, when the Budget was already that', () => {
    expect(savedMessage('Groceries', { effectiveFrom: '2026-10', amountCents: 80_050, changed: false })).toBe('Groceries already has a Budget of $800.50 a month in October 2026, so nothing changed.')
    expect(savedMessage('Groceries', { effectiveFrom: '2026-10', amountCents: null, changed: false })).toBe('Groceries has no Budget in October 2026, so there is nothing to end.')
  })
})
