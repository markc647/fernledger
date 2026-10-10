import * as z from 'zod/mini'
import { describe, expect, it } from 'vitest'
import { budgetBody, budgetVsActual, describeChange, MAX_BUDGET_CENTS, withChanges, type Change, type InEffect } from './budget-rules'
import { MAX_AMOUNT_CENTS } from './rule-criteria'

const field = (value: unknown) => {
  const parsed = z.safeParse(budgetBody, value)
  return parsed.success ? null : parsed.error.issues[0]?.path.join('.')
}

describe('what setting a Budget takes', () => {
  it("is as large as the amount box on the page can read, which is a Rule's limit (src/lib/rules.ts readDollars)", () => {
    expect(MAX_BUDGET_CENTS).toBe(MAX_AMOUNT_CENTS)
  })

  it.each([
    [{ effectiveFrom: '2026-10', amountCents: 50_000 }],
    [{ effectiveFrom: '2000-01', amountCents: 1 }],
    [{ effectiveFrom: '2100-12', amountCents: MAX_BUDGET_CENTS }],
    [{ effectiveFrom: '2026-10', amountCents: null }], // ends the Budget from that month
  ])('accepts %j', (body) => {
    expect(field(body)).toBeNull()
  })

  it.each([
    ['a missing month', { amountCents: 100 }, 'effectiveFrom'],
    ['a month that is not a month', { effectiveFrom: '2026-13', amountCents: 100 }, 'effectiveFrom'],
    ['a date instead of a month', { effectiveFrom: '2026-10-01', amountCents: 100 }, 'effectiveFrom'],
    ['a month before 2000', { effectiveFrom: '1999-12', amountCents: 100 }, 'effectiveFrom'],
    ['a month after 2100', { effectiveFrom: '2101-01', amountCents: 100 }, 'effectiveFrom'],
    ['a month that is a number', { effectiveFrom: 202610, amountCents: 100 }, 'effectiveFrom'],
    ['a missing amount', { effectiveFrom: '2026-10' }, 'amountCents'],
    ['an amount of nothing, which "none" says better', { effectiveFrom: '2026-10', amountCents: 0 }, 'amountCents'],
    ['a negative amount', { effectiveFrom: '2026-10', amountCents: -500 }, 'amountCents'],
    ['part of a cent', { effectiveFrom: '2026-10', amountCents: 10.5 }, 'amountCents'],
    ['an amount typed as text', { effectiveFrom: '2026-10', amountCents: '500' }, 'amountCents'],
    ['an amount over the most a Budget can be', { effectiveFrom: '2026-10', amountCents: MAX_BUDGET_CENTS + 1 }, 'amountCents'],
  ])('refuses %s, naming the field', (_why, body, name) => {
    expect(field(body)).toBe(name)
  })
})

const entry = (categoryId: number, categoryName: string, amountCents: number | null, effectiveFrom: string | null): InEffect => ({ categoryId, categoryName, amountCents, effectiveFrom })
const change = (categoryId: number, effectiveFrom: string, amountCents: number | null): Change => ({ categoryId, effectiveFrom, amountCents })

describe('withChanges', () => {
  it("gives each Category its own changes, oldest month first, and an empty list when it has none", () => {
    const rows = withChanges(
      [entry(1, 'Fuel', 9000, '2026-08'), entry(2, 'Groceries', null, null)],
      [change(1, '2026-08', 9000), change(3, '2026-01', 100), change(1, '2026-12', null)],
    )

    expect(rows).toEqual([
      { ...entry(1, 'Fuel', 9000, '2026-08'), changes: [{ effectiveFrom: '2026-08', amountCents: 9000 }, { effectiveFrom: '2026-12', amountCents: null }] },
      { ...entry(2, 'Groceries', null, null), changes: [] },
    ])
  })
})

describe('budgetVsActual', () => {
  const inEffect = [entry(1, 'Fuel', 9000, '2026-08'), entry(2, 'Groceries', 80_000, '2026-01'), entry(3, 'Eating out', null, null), entry(4, 'Travel', null, '2026-06')]

  it('gives every Category with a Budget its Budget and what it has spent, and leaves out Categories with none', () => {
    const rows = budgetVsActual(inEffect, [
      { month: '2026-10', categoryId: 1, outCents: 9500, inCents: 0 },
      { month: '2026-10', categoryId: 3, outCents: 100, inCents: 0 }, // no Budget: not shown
      { month: '2026-10', categoryId: null, outCents: 700, inCents: 0 }, // Uncategorised: has no Budget
    ])

    expect(rows).toEqual([
      { categoryId: 1, categoryName: 'Fuel', budgetCents: 9000, spentCents: 9500 },
      { categoryId: 2, categoryName: 'Groceries', budgetCents: 80_000, spentCents: 0 },
    ])
  })

  it('counts a refund against what was spent, and can come out below zero', () => {
    const rows = budgetVsActual(inEffect, [
      { month: '2026-10', categoryId: 1, outCents: 9500, inCents: 2000 },
      { month: '2026-10', categoryId: 2, outCents: 0, inCents: 1500 },
    ])

    expect(rows.map((r) => r.spentCents)).toEqual([7500, -1500])
  })

  it('keeps the order it was given', () => {
    expect(budgetVsActual([...inEffect].reverse(), []).map((r) => r.categoryName)).toEqual(['Groceries', 'Fuel'])
  })
})

describe('describeChange', () => {
  it('says a first Budget was set, with the month in words and the amount in dollars', () => {
    expect(describeChange('Groceries', '2026-10', null, 80_050)).toEqual({
      summary: 'Set the Budget for Groceries to $800.50 a month from October 2026',
      before: { category: 'Groceries', fromMonth: 'October 2026', monthlyBudget: null },
      after: { category: 'Groceries', fromMonth: 'October 2026', monthlyBudget: '$800.50' },
    })
  })

  it('says what a Budget changed from and to', () => {
    expect(describeChange('Groceries', '2026-12', 80_000, 1_000_000)).toEqual({
      summary: 'Changed the Budget for Groceries from $800.00 to $10,000.00 a month from December 2026',
      before: { category: 'Groceries', fromMonth: 'December 2026', monthlyBudget: '$800.00' },
      after: { category: 'Groceries', fromMonth: 'December 2026', monthlyBudget: '$10,000.00' },
    })
  })

  it('says a Budget ended', () => {
    expect(describeChange('Fuel', '2027-01', 9000, null)).toEqual({
      summary: 'Ended the Budget for Fuel from January 2027',
      before: { category: 'Fuel', fromMonth: 'January 2027', monthlyBudget: '$90.00' },
      after: { category: 'Fuel', fromMonth: 'January 2027', monthlyBudget: null },
    })
  })
})
