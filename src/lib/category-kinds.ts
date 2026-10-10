import type { CategoryKind } from '@/generated/api/category-kinds'

// What a Category is for (ADR 0012). The Worker's category-kinds.ts is the list; typing these as records of its kinds makes the build fail if one is added without words here.
export type { CategoryKind }

/** In the order the Admin is offered them. */
export const KINDS: CategoryKind[] = ['spending', 'income', 'loans']

export const KIND_LABELS: Record<CategoryKind, string> = { spending: 'Spending', income: 'Income', loans: 'Loans' }

/** One line on what each kind means, shown beside the choice. */
export const KIND_HINTS: Record<CategoryKind, string> = {
  spending: 'Counts as spending, and can have a Budget.',
  income: 'Counts as income, and has no Budget.',
  loans: 'Money lent or borrowed. Not spending or income, and has no Budget.',
}
