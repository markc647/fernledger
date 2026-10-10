import { env } from 'cloudflare:workers'
import * as z from 'zod/mini'
import { beforeEach, describe, expect, it } from 'vitest'
import { budgetBody, budgetInMonth, budgetVsActual, describeChange, IN_EFFECT, withChanges, type Change, type InEffect } from './budget-rules'
import { MAX_AMOUNT_CENTS } from './rule-criteria'
import type { SpendingRow } from './spending'

const field = (value: unknown) => {
  const parsed = z.safeParse(budgetBody, value)
  return parsed.success ? null : parsed.error.issues[0]?.path.join('.')
}

describe('what setting a Budget takes', () => {
  it.each([
    [{ effectiveFrom: '2026-10', amountCents: 50_000 }],
    [{ effectiveFrom: '2000-01', amountCents: 1 }],
    [{ effectiveFrom: '2100-12', amountCents: MAX_AMOUNT_CENTS }],
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
    ['an amount over the most a Budget can be', { effectiveFrom: '2026-10', amountCents: MAX_AMOUNT_CENTS + 1 }, 'amountCents'],
  ])('refuses %s, naming the field', (_why, body, name) => {
    expect(field(body)).toBe(name)
  })
})

const entry = (categoryId: number, categoryName: string, amountCents: number | null, effectiveFrom: string | null): InEffect => ({ categoryId, categoryName, amountCents, effectiveFrom })
const change = (categoryId: number, effectiveFrom: string, amountCents: number | null): Change => ({ categoryId, effectiveFrom, amountCents })

// The same cases for the pure rule and for the SQL (IN_EFFECT): each is a history of changes, and what every month from 2026-05 to 2027-08 has.
const HISTORIES: { name: string; changes: { effectiveFrom: string; amountCents: number | null }[] }[] = [
  { name: 'no changes', changes: [] },
  { name: 'one change', changes: [{ effectiveFrom: '2026-08', amountCents: 80_000 }] },
  { name: 'two changes', changes: [{ effectiveFrom: '2026-08', amountCents: 80_000 }, { effectiveFrom: '2026-11', amountCents: 90_000 }] },
  { name: 'two changes, the later one added first', changes: [{ effectiveFrom: '2026-11', amountCents: 90_000 }, { effectiveFrom: '2026-08', amountCents: 80_000 }] },
  { name: 'a Budget that ends, and starts again', changes: [{ effectiveFrom: '2026-08', amountCents: 80_000 }, { effectiveFrom: '2026-12', amountCents: null }, { effectiveFrom: '2027-03', amountCents: 50_000 }] },
  { name: 'an ending with no Budget before it', changes: [{ effectiveFrom: '2026-09', amountCents: null }] },
  { name: 'changes across a year end', changes: [{ effectiveFrom: '2026-12', amountCents: 1 }, { effectiveFrom: '2027-01', amountCents: 2 }] },
]
const MONTHS = Array.from({ length: 16 }, (_, i) => `${2026 + Math.floor((4 + i) / 12)}-${String(((4 + i) % 12) + 1).padStart(2, '0')}`)

describe('budgetInMonth', () => {
  it('has no Budget before the first change', () => {
    expect(budgetInMonth([{ effectiveFrom: '2026-08', amountCents: 80_000 }], '2026-07')).toEqual({ amountCents: null, effectiveFrom: null })
    expect(budgetInMonth([], '2026-07')).toEqual({ amountCents: null, effectiveFrom: null })
  })

  it('begins in the month of a change, carries on until the next, and takes the latest change on or before the month', () => {
    const changes = [{ effectiveFrom: '2026-11', amountCents: 90_000 }, { effectiveFrom: '2026-08', amountCents: 80_000 }]

    expect(budgetInMonth(changes, '2026-08')).toEqual({ amountCents: 80_000, effectiveFrom: '2026-08' })
    expect(budgetInMonth(changes, '2026-10')).toEqual({ amountCents: 80_000, effectiveFrom: '2026-08' })
    expect(budgetInMonth(changes, '2026-11')).toEqual({ amountCents: 90_000, effectiveFrom: '2026-11' })
    expect(budgetInMonth(changes, '2030-01')).toEqual({ amountCents: 90_000, effectiveFrom: '2026-11' })
  })

  it('has no amount from the month a Budget ends', () => {
    const changes = [{ effectiveFrom: '2026-08', amountCents: 80_000 }, { effectiveFrom: '2026-12', amountCents: null }]

    expect(budgetInMonth(changes, '2026-12')).toEqual({ amountCents: null, effectiveFrom: '2026-12' })
    expect(budgetInMonth(changes, '2027-06')).toEqual({ amountCents: null, effectiveFrom: '2026-12' })
  })

  describe('agrees with the SQL (IN_EFFECT) for every month of every history', () => {
    let categoryId = 0
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM budgets').run()
      categoryId = (await env.DB.prepare("SELECT id FROM categories WHERE name = 'Groceries'").first<{ id: number }>())!.id
    })

    it.each(HISTORIES)('$name', async ({ changes }) => {
      if (changes.length > 0) await env.DB.batch(changes.map((c) => env.DB.prepare('INSERT INTO budgets (category_id, effective_from_month, amount_cents) VALUES (?, ?, ?)').bind(categoryId, c.effectiveFrom, c.amountCents)))

      for (const month of MONTHS) {
        const sql = (await env.DB.prepare(IN_EFFECT).bind(month).all<InEffect>()).results.find((r) => r.categoryId === categoryId)!
        expect({ month, ...budgetInMonth(changes, month) }, month).toEqual({ month, amountCents: sql.amountCents, effectiveFrom: sql.effectiveFrom })
      }
    })
  })
})

describe('IN_EFFECT', () => {
  it('lists the Spending Categories in use and no others: an Income or Loans Category cannot have a Budget', async () => {
    const names = (await env.DB.prepare(IN_EFFECT).bind('2026-10').all<InEffect>()).results.map((r) => r.categoryName)

    expect(names).toEqual(expect.arrayContaining(['Groceries', 'Fuel']))
    for (const other of ['Wages and salary', 'NZ Super and benefits', 'Interest', 'Other income', 'Loans']) expect(names).not.toContain(other)
  })
})

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
  const spend = (categoryId: number | null, outCents: number, inCents = 0, kind: SpendingRow['kind'] = 'spending'): SpendingRow => ({ month: '2026-10', categoryId, kind, outCents, inCents })

  it('gives every Category with a Budget its Budget and what it spent, and leaves out Categories with none', () => {
    const { rows } = budgetVsActual(inEffect, [spend(1, 9500), spend(3, 100), spend(null, 700)])

    expect(rows).toEqual([
      { categoryId: 1, categoryName: 'Fuel', budgetCents: 9000, spentCents: 9500 },
      { categoryId: 2, categoryName: 'Groceries', budgetCents: 80_000, spentCents: 0 },
    ])
  })

  it('counts a refund against what was spent, and can come out below zero', () => {
    const { rows } = budgetVsActual(inEffect, [spend(1, 9500, 2000), spend(2, 0, 1500)])

    expect(rows.map((r) => r.spentCents)).toEqual([7500, -1500])
  })

  it('adds up the Spending Categories with no Budget as spending outside Budgets, and Uncategorised on its own', () => {
    const { otherCents, uncategorisedCents } = budgetVsActual(inEffect, [spend(1, 9500), spend(3, 100), spend(4, 1000, 250), spend(null, 700)])

    expect(otherCents).toBe(100 + 750)
    expect(uncategorisedCents).toBe(700)
  })

  it('counts money in that has no Category yet against Uncategorised, which can go below zero', () => {
    const { otherCents, uncategorisedCents } = budgetVsActual(inEffect, [spend(null, 700, 300_000)])

    expect(uncategorisedCents).toBe(-299_300)
    expect(otherCents).toBe(0)
  })

  it('adds up rows of several months for a Category, and does not let the last month stand for the rest', () => {
    const month = (m: string, categoryId: number | null, outCents: number): SpendingRow => ({ month: m, categoryId, kind: 'spending', outCents, inCents: 0 })

    const { rows, otherCents, uncategorisedCents } = budgetVsActual(inEffect, [month('2026-09', 1, 4000), month('2026-10', 1, 500), month('2026-09', 3, 100), month('2026-10', 3, 20), month('2026-09', null, 7), month('2026-10', null, 1)])

    expect(rows[0]).toMatchObject({ categoryId: 1, spentCents: 4500 })
    expect(otherCents).toBe(120)
    expect(uncategorisedCents).toBe(8)
  })

  it('leaves Income and Loans out of the rest, since they are not spending', () => {
    const { rows, otherCents, uncategorisedCents } = budgetVsActual(inEffect, [spend(1, 9500), spend(6, 0, 300_000, 'income'), spend(7, 50_000, 0, 'loans'), spend(null, 700)])

    expect(rows).toHaveLength(2)
    expect(otherCents).toBe(0)
    expect(uncategorisedCents).toBe(700)
  })

  it('has nothing outside Budgets when everything is in one', () => {
    expect(budgetVsActual(inEffect, [spend(1, 9500)])).toMatchObject({ otherCents: 0, uncategorisedCents: 0 })
    expect(budgetVsActual(inEffect, [])).toEqual({
      rows: [{ categoryId: 1, categoryName: 'Fuel', budgetCents: 9000, spentCents: 0 }, { categoryId: 2, categoryName: 'Groceries', budgetCents: 80_000, spentCents: 0 }],
      otherCents: 0,
      uncategorisedCents: 0,
    })
  })

  it('keeps the order it was given', () => {
    expect(budgetVsActual([...inEffect].reverse(), []).rows.map((r) => r.categoryName)).toEqual(['Groceries', 'Fuel'])
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
