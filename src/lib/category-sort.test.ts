import { describe, expect, it } from 'vitest'
import { sortCategories, type CategorySort } from './category-sort'
import type { CategoryKind } from './category-kinds'

const category = (id: number, name: string, kind: CategoryKind = 'spending') => ({ id, name, kind })

// In the order the Worker lists them: by name.
const listed = [category(1, 'Care Fees'), category(2, 'Groceries'), category(3, 'Loan – Alice', 'loans'), category(4, 'Salary', 'income'), category(5, 'Travel'), category(6, 'Wages', 'income')]
const names = (rows: { name: string }[]) => rows.map((row) => row.name)
const sorted = (sort: CategorySort | null, rows = listed) => names(sortCategories(rows, sort))

describe('sorting the Categories', () => {
  it('leaves them in the order the Worker listed them when nothing is chosen', () => {
    expect(sortCategories(listed, null)).toBe(listed)
  })

  it('sorts by name, A to Z or Z to A', () => {
    expect(sorted({ key: 'name', direction: 'ascending' })).toEqual(['Care Fees', 'Groceries', 'Loan – Alice', 'Salary', 'Travel', 'Wages'])
    expect(sorted({ key: 'name', direction: 'descending' })).toEqual(['Wages', 'Travel', 'Salary', 'Loan – Alice', 'Groceries', 'Care Fees'])
  })

  it('ignores capital letters and puts a letter with a macron with its plain letter', () => {
    const rows = [category(1, 'zoo'), category(2, 'Ōtaki trips'), category(3, 'Apples'), category(4, 'banana'), category(5, 'Otago')]
    expect(sorted({ key: 'name', direction: 'ascending' }, rows)).toEqual(['Apples', 'banana', 'Otago', 'Ōtaki trips', 'zoo'])
  })

  it('reads numbers as numbers, so Loan 2 comes before Loan 10', () => {
    const rows = [category(1, 'Loan 10'), category(2, 'Loan 2'), category(3, 'Loan 1')]
    expect(sorted({ key: 'name', direction: 'ascending' }, rows)).toEqual(['Loan 1', 'Loan 2', 'Loan 10'])
  })

  it("sorts by the Kind's label (Income, Loans, Spending), and by name within a Kind", () => {
    expect(sorted({ key: 'kind', direction: 'ascending' })).toEqual(['Salary', 'Wages', 'Loan – Alice', 'Care Fees', 'Groceries', 'Travel'])
  })

  it('reverses the Kinds for Z to A and keeps the names within a Kind A to Z', () => {
    expect(sorted({ key: 'kind', direction: 'descending' })).toEqual(['Care Fees', 'Groceries', 'Travel', 'Loan – Alice', 'Salary', 'Wages'])
  })

  it('places a Kind by the word the reader sees', () => {
    const rows = [category(1, 'A', 'spending'), category(2, 'B', 'loans'), category(3, 'C', 'income')]
    expect(sorted({ key: 'kind', direction: 'ascending' }, rows)).toEqual(['C', 'B', 'A'])
    expect(sorted({ key: 'kind', direction: 'descending' }, rows)).toEqual(['A', 'B', 'C'])
  })

  it('does not change the list it was given', () => {
    const copy = listed.slice()
    sortCategories(listed, { key: 'name', direction: 'descending' })
    expect(listed).toEqual(copy)
  })

  it('puts Categories whose names read the same in the order of their ids, as the Worker lists them', () => {
    const rows = [category(9, 'Cafe'), category(3, 'Café'), category(5, 'CAFE')]
    expect(sortCategories(rows, { key: 'name', direction: 'ascending' }).map((row) => row.id)).toEqual([3, 5, 9])
  })
})
