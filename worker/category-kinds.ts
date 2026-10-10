// What a Category is for, which decides how its Transactions are totalled (ADR 0012). The Admin sets it on the Categories page.
// The rules that use it are in spending.ts.

export const CATEGORY_KINDS = ['spending', 'income', 'loans'] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

/** How the Change Log and the pages name a kind. */
export const KIND_LABELS: Record<CategoryKind, string> = { spending: 'Spending', income: 'Income', loans: 'Loans' }

/** The kind of a Transaction with no Category: Uncategorised counts as Spending (ADR 0012). */
export const UNCATEGORISED_KIND: CategoryKind = 'spending'
