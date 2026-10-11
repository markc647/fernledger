import type { Column } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { Status } from '@/components/status'
import { budgetStatus, type BudgetRow } from '@/lib/budgets'
import { formatBalance } from '@/lib/format'

const money = 'whitespace-nowrap tabular-nums [font-kerning:none]'

/**
 * The columns of a month of Budget vs actual, the same on the Summary and in the Report: Category, Budget, Spent and where it stands (an icon and words, never colour
 * alone). `className` is for the table's cells and headings, such as the Report's tighter padding on paper.
 */
export function budgetColumns(className?: string): Column<BudgetRow>[] {
  return [
    { key: 'category', header: 'Category', className, cell: (row) => row.name },
    { key: 'budget', header: 'Budget', align: 'end', className, cell: (row) => (row.budgetCents === null ? 'No Budget' : <span className={money}>{formatBalance(row.budgetCents)}</span>) },
    { key: 'spent', header: 'Spent', align: 'end', className, cell: (row) => <Spent cents={row.spentCents} /> },
    {
      key: 'status',
      header: 'Status',
      className,
      cell: (row) => {
        if (row.budgetCents === null) return <Status tone="neutral">Not in a Budget</Status>
        const status = budgetStatus(row.budgetCents, row.spentCents)
        return (
          <span className="inline-flex flex-col items-start">
            <Status tone={status.tone}>{status.words}</Status>
            <span className="text-muted-foreground tabular-nums">{status.detail}</span>
          </span>
        )
      },
    },
  ]
}
