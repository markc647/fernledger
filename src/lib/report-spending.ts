import type { SpendingLine, SpendingReport } from '@/generated/api/report-spending'

// The spending-by-Category Report's data and words, from the API (worker/report-spending.ts, one request for all the Accounts or the one
// chosen). Every number comes from the API and none is added up again here, not even the total: spending is worked out in one place
// (worker/spending.ts, ADR 0012). This file only chooses the rows and what to say.

export type { SpendingLine, SpendingReport }

/** A row of the table: a Spending Category, or Uncategorised, which is its own row. */
export type SpendingRow = { key: string; name: string; cents: number }

/** Where the Report says Uncategorised, which counts as Spending and so has a row of its own. */
export const UNCATEGORISED = 'Uncategorised'

/** The Categories as the API ordered them (largest first), then Uncategorised on its own at the end, when anything in the dates is Uncategorised. */
export function spendingRows(report: SpendingReport): SpendingRow[] {
  const rows = report.categories.map((line) => ({ key: `category-${line.categoryId}`, name: line.categoryName, cents: line.cents }))
  return report.uncategorisedCents === null ? rows : [...rows, { key: 'uncategorised', name: UNCATEGORISED, cents: report.uncategorisedCents }]
}

/** What the Report says when nothing in the dates was Spending: no table, no total. */
export const NO_SPENDING = 'No Spending in these dates.'

/** The Accounts as the table heading on paper says them: "All Accounts" when none was chosen (the title block above lists them), or the Account with its bank number. */
export const accountsForHeading = (allAccounts: boolean, accountsText: string) => (allAccounts ? 'All Accounts' : accountsText)
