import { KIND_LABELS, type CategoryKind } from './category-kinds'

// How the Categories page sorts its list. The Worker lists Categories by name (worker/categories.ts) and the page keeps that order until the reader chooses another, so there are
// only two sorts, each way. A small list, sorted here rather than asked of the Worker.

export type CategorySortKey = 'name' | 'kind'
export type CategorySortDirection = 'ascending' | 'descending'
export type CategorySort = { key: CategorySortKey; direction: CategorySortDirection }

/** What each direction means, in plain words: for the heading's button, the menu on cards and the line that announces a change. */
export const CATEGORY_SORT_WORDS: Record<CategorySortDirection, string> = { ascending: 'A to Z', descending: 'Z to A' }

// Capital letters and macrons do not decide the order ("Ōtaki" is among the Os), and a number reads as a number ("Loan 2" is before "Loan 10").
const byWords = new Intl.Collator('en-NZ', { sensitivity: 'base', numeric: true })

type Sortable = { id: number; name: string; kind: CategoryKind }

/**
 * The Categories in the chosen order, or as they are (the Worker's order) when none is chosen. A Kind is sorted by the label the reader sees, and Categories of one Kind
 * are in name order, A to Z, whichever way the Kinds go. Categories whose names read the same stay in the Worker's order, by id.
 */
export function sortCategories<Category extends Sortable>(categories: Category[], sort: CategorySort | null): Category[] {
  if (sort === null) return categories
  const sign = sort.direction === 'ascending' ? 1 : -1
  return categories.toSorted((a, b) => {
    const kinds = sort.key === 'kind' ? sign * byWords.compare(KIND_LABELS[a.kind], KIND_LABELS[b.kind]) : 0
    if (kinds !== 0) return kinds
    const names = byWords.compare(a.name, b.name)
    return names !== 0 ? (sort.key === 'name' ? sign * names : names) : a.id - b.id
  })
}
