import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Column<Row> = {
  key: string
  /** Heading in the table, and the label beside the value in a card. */
  header: string
  cell: (row: Row) => ReactNode
  /** Right-align (money and numbers). */
  align?: 'start' | 'end'
}

/**
 * Data as a table on a wide screen and as one card per row on a narrow one (below 768px, which is also what a phone,
 * or a desktop browser at 200% zoom, looks like), so nothing ever scrolls sideways. Text is never below 15px.
 * `caption` names the data for screen readers in both layouts. Both layouts are in the page; the hidden one is
 * `display: none`, so assistive technology reads only the one on screen.
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
  if (rows.length === 0) return <p>{emptyMessage}</p>
  const align = (column: Column<Row>) => (column.align === 'end' ? 'text-end' : 'text-start')
  return (
    <>
      <table className="hidden w-full border-collapse text-[0.9375rem] md:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b-2">
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cn('px-3 py-2 font-semibold', align(column))}>
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

      <ul aria-label={caption} className="grid gap-3 text-[0.9375rem] md:hidden">
        {rows.map((row) => (
          <li key={getRowKey(row)} className="rounded-xl border bg-card p-4 text-card-foreground">
            <dl className="grid gap-2">
              {columns.map((column) => (
                <div key={column.key} className="flex items-start justify-between gap-4">
                  <dt className="text-muted-foreground">{column.header}</dt>
                  <dd className="min-w-0 text-end">{column.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
