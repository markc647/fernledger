import { useId, type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The panel that a row's one action opens (Edit a Transaction's Category and Note, Rename an Account, Edit a Budget): a stock shadcn Card, a region named by its `h2`, with the form in it. In a table it is the
 * `expanded` row of `ResponsiveTable` (src/components/responsive-table.tsx), directly under its row and across the table, so it has the width of the table (the form inside keeps a width a line of text reads well in).
 * What the app needs on top of the Card is on this one card and not in `ui/card.tsx`, as in `DashboardCard`: a border as well as the stock ring, which is a shadow that Windows high contrast removes, no
 * `overflow-hidden`, which would hide a long word the page's checks should see, and `min-w-0`, so a card in a cell shrinks to it.
 */
export function RowPanel({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Card role="region" aria-labelledby={headingId} className={cn('min-w-0 overflow-visible border ring-0', className)}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold break-words">
          <h2 id={headingId}>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-xl">{children}</div>
      </CardContent>
    </Card>
  )
}
