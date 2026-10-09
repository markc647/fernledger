import { useSyncExternalStore, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Column<Row> = {
  key: string
  /** Heading in the table, and the label beside the value in a card. */
  header: string
  cell: (row: Row) => ReactNode
  /** Right-align (money and numbers). */
  align?: 'start' | 'end'
  /** Keep the heading on one line, for a narrow column (such as a number) that the other columns would otherwise squeeze until its heading breaks. */
  nowrap?: boolean
}

// Tailwind's `md` breakpoint. In rem, like the CSS, so a page zoomed to 200% switches layout exactly as it did.
// Print is always the table, so a Report printed from a phone is still a table.
const WIDE = '(min-width: 48rem), print'

function useIsWide() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => window.matchMedia(WIDE).matches,
  )
}

/**
 * Data as a table on a wide screen and as one card per row on a narrow one (below 768px, which is also what a phone,
 * or a desktop browser at 200% zoom, looks like), so nothing ever scrolls sideways. Text is never below 15px.
 * `caption` names the data for screen readers in both layouts. Only the layout on screen is rendered, so each cell
 * is built once (a cell with an `id` or a form control never appears twice in the page).
 */
export function ResponsiveTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  emptyMessage = 'Nothing to show yet.',
}: {
  caption: string
  columns: Column<Row>[]
  rows: Row[]
  getRowKey: (row: Row) => string | number
  emptyMessage?: string
}) {
  const wide = useIsWide()
  // The caption stays on the empty state: a screen reader still hears what the missing data was.
  if (rows.length === 0)
    return (
      <p>
        <span className="sr-only">{caption}: </span>
        {emptyMessage}
      </p>
    )
  const align = (column: Column<Row>) => (column.align === 'end' ? 'text-end' : 'text-start')
  if (!wide) {
    return (
      <ul aria-label={caption} className="grid gap-3 text-[0.9375rem]">
        {rows.map((row) => (
          <li key={getRowKey(row)} className="rounded-xl border bg-card p-4 text-card-foreground">
            <dl className="grid gap-2">
              {columns.map((column) => (
                <div key={column.key} className="flex items-start justify-between gap-4">
                  <dt className="shrink-0 text-muted-foreground">{column.header}</dt>
                  <dd className="min-w-0 text-end break-words">{column.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <table className="w-full border-collapse text-[0.9375rem]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b-2">
          {columns.map((column) => (
            <th key={column.key} scope="col" className={cn('px-3 py-2 font-semibold', column.nowrap && 'whitespace-nowrap', align(column))}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={getRowKey(row)} className="border-b">
            {columns.map((column) => (
              <td key={column.key} className={cn('px-3 py-3 align-top', align(column))}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
