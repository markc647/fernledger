import type { CategoryKind } from '../generated/api/category-kinds' // relative, not '@/': a Worker test imports this file (worker/report-loans.test.ts)

// What a Category is for (ADR 0012). The Worker's category-kinds.ts is the list; typing these as records of its kinds makes the build fail if one is added without words here.
export type { CategoryKind }

/** In the order the Admin is offered them. */
export const KINDS: CategoryKind[] = ['spending', 'income', 'loans']

/** Loans: neither Spending nor Income. The Worker's `isLoansKind` (category-kinds.ts) and SQL `isLoan` (spending.ts) say so for the Worker; this is the same word for the pages, checked against the Worker's kinds by its type. */
export const LOANS = 'loans' satisfies CategoryKind
export const isLoansKind = (kind: CategoryKind): kind is typeof LOANS => kind === LOANS

export const KIND_LABELS: Record<CategoryKind, string> = { spending: 'Spending', income: 'Income', loans: 'Loans' }

/** One line on what each kind means, shown beside the choice. */
export const KIND_HINTS: Record<CategoryKind, string> = {
  spending: 'Counts as spending, and can have a Budget.',
  income: 'Counts as income, and has no Budget.',
  loans: 'Money lent or borrowed. Make one Category for each person, named like Loan – Alice, and give it their Transactions with a Rule or an Override. The Loans Report shows what each owes. Not spending or income, and has no Budget.',
}

/** What a list says under a Transaction's Category when its kind is not the usual one, so a loan or a wage is not read as spending. Spending needs no note. */
export const KIND_NOTES: Record<CategoryKind, string | null> = { spending: null, income: 'Income', loans: 'Loan, not spending' }
