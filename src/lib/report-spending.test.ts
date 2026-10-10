import { describe, expect, it } from 'vitest'
import type { SpendingReport } from '@/generated/api/report-spending'
import { accountsForHeading, spendingRows } from './report-spending'

// What the spending-by-Category Report puts in its table, as pure functions (src/lib/report-spending.ts); worker/report-spending.test.ts holds
// its numbers to the Worker's spending totals, and e2e/report-spending.spec.ts checks how it reads and prints.

const report = (over: Partial<SpendingReport> = {}): SpendingReport => ({
  accountId: null,
  from: '2026-10-01',
  to: '2026-10-31',
  categories: [
    { categoryId: 4, categoryName: 'Tax', cents: 30_000 },
    { categoryId: 2, categoryName: 'Groceries', cents: 5550 },
  ],
  uncategorisedCents: 400,
  totalCents: 35_950,
  ...over,
})

describe('spendingRows', () => {
  it('keeps the Categories in the order the API gave them and puts Uncategorised last, on its own', () => {
    expect(spendingRows(report())).toEqual([
      { key: 'category-4', name: 'Tax', cents: 30_000 },
      { key: 'category-2', name: 'Groceries', cents: 5550 },
      { key: 'uncategorised', name: 'Uncategorised', cents: 400 },
    ])
  })

  it('has no Uncategorised row while nothing in the dates is Uncategorised, but keeps one that came to nothing or went below zero', () => {
    expect(spendingRows(report({ uncategorisedCents: null })).map((row) => row.name)).toEqual(['Tax', 'Groceries'])
    expect(spendingRows(report({ uncategorisedCents: 0 })).at(-1)).toEqual({ key: 'uncategorised', name: 'Uncategorised', cents: 0 })
    expect(spendingRows(report({ uncategorisedCents: -250 })).at(-1)).toMatchObject({ cents: -250 })
  })

  it('has no rows for no Spending', () => {
    expect(spendingRows(report({ categories: [], uncategorisedCents: null, totalCents: 0 }))).toEqual([])
  })

  it('gives each row a key of its own, even for a Category called Uncategorised', () => {
    const rows = spendingRows(report({ categories: [{ categoryId: 9, categoryName: 'Uncategorised', cents: 100 }] }))
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})

describe('accountsForHeading', () => {
  it('says All Accounts when none was chosen, and the Account itself when one was', () => {
    expect(accountsForHeading(true, 'All Accounts: Example savings (99-9999-9999999-99); Example cheque (99-9999-9999999-98)')).toBe('All Accounts')
    expect(accountsForHeading(false, 'Example savings (99-9999-9999999-99)')).toBe('Example savings (99-9999-9999999-99)')
  })
})
