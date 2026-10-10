import { useId, useSyncExternalStore, type ReactNode } from 'react'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type SortDirection = 'ascending' | 'descending'

export type Column<Row> = {
  key: string
  /** Heading in the table, and the label beside the value in a card. */
  header: string
  cell: (row: Row) => ReactNode
  /** Right-align (money and numbers). */
  align?: 'start' | 'end'
  /** Classes for the column's heading and cells in the table (not on cards), such as `whitespace-nowrap` for a date. */
  className?: string
  /**
   * Lets the reader sort by this column. In the table its heading is a button; on cards, where there are no headings, a
   * "Sort by" menu lists it. The table only shows the order it is given: `set` is where the page re-sorts (here, on the server).
   */
  sort?: {
    /** The column's current order, or null while the rows are sorted by another column. */
    direction: SortDirection | null
    set: (direction: SortDirection) => void
    /** The way a first click on the heading sorts. Defaults to ascending. */
    first?: SortDirection
    /** What each direction means for this column, in plain words: "A to Z", "newest first". */
    labels: Record<SortDirection, string>
  }
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

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** An arrow that points the way the column is sorted; two arrows while it isn't. Drawn with strokes, so Windows high contrast keeps it. */
function SortArrow({ direction }: { direction: SortDirection | null }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {direction !== 'descending' && <path d="M7 10l5-5 5 5" />}
      {direction !== 'ascending' && <path d="M7 14l5 5 5-5" />}
    </svg>
  )
}

function SortHeading<Row>({ column }: { column: Column<Row> & { sort: NonNullable<Column<Row>['sort']> } }) {
  const { direction, set, first = 'ascending' } = column.sort
  return (
    <button
      type="button"
      className={cn('inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 font-semibold hover:underline underline-offset-4', focusStyle)}
      onClick={() => set(direction === null ? first : direction === 'ascending' ? 'descending' : 'ascending')}
    >
      {column.header}
      <SortArrow direction={direction} />
    </button>
  )
}

/** The sort control for cards: one menu of every column and direction. */
function SortMenu<Row>({ columns }: { columns: Column<Row>[] }) {
  const id = useId()
  const sortable = columns.filter((column): column is Column<Row> & { sort: NonNullable<Column<Row>['sort']> } => column.sort !== undefined)
  if (sortable.length === 0) return null
  const current = sortable.find((column) => column.sort.direction !== null)
  return (
    <div className="mb-3">
      <label htmlFor={id} className="block font-medium">
        Sort by
      </label>
      <Select
        id={id}
        value={current ? `${current.key}:${current.sort.direction}` : ''}
        onChange={(event) => {
          const [key, direction] = event.target.value.split(':')
          sortable.find((column) => column.key === key)?.sort.set(direction as SortDirection)
        }}
        className="max-w-sm"
      >
        {!current && <option value="">Not sorted</option>}
        {sortable.flatMap((column) =>
          (['ascending', 'descending'] as const).map((direction) => (
            <option key={`${column.key}:${direction}`} value={`${column.key}:${direction}`}>
              {column.header}, {column.sort.labels[direction]}
            </option>
          )),
        )}
      </Select>
    </div>
  )
}

/**
 * Data as a table on a wide screen and as one card per row on a narrow one (below 768px, which is also what a phone,
 * or a desktop browser at 200% zoom, looks like), so nothing ever scrolls sideways. Text is never below 15px.
 * `caption` names the data for screen readers in both layouts. Only the layout on screen is rendered, so each cell
 * is built once (a cell with an `id` or a form control never appears twice in the page).
 * A column with `sort` can be sorted by the reader: by its heading in the table, from a "Sort by" menu on cards.
 */
export function ResponsiveTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  emptyMessage = 'Nothing to show yet.',
  className,
  printHeading,
}: {
  caption: string
  columns: Column<Row>[]
  rows: Row[]
  getRowKey: (row: Row) => string | number
  emptyMessage?: string
  /** For the table (the wide layout), such as `print:text-[12pt]` on a Report. */
  className?: string
  /**
   * Shown above the column headings on paper only, and so repeated with them at the top of every page the table runs onto: what the
   * table is, when the page around it won't say (a Report's "app – Report – Account – dates" line).
   */
  printHeading?: ReactNode
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
      <>
        <SortMenu columns={columns} />
        {/* One column that may shrink to the window: without it a card is as wide as its longest unbroken word (a long web address in a Note). */}
        <ul aria-label={caption} className="grid grid-cols-1 gap-3 text-[0.9375rem]">
          {rows.map((row) => (
            <li key={getRowKey(row)} className="rounded-xl border bg-card p-4 text-card-foreground">
              <dl className="grid grid-cols-1 gap-2">
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
      </>
    )
  }
  return (
    <table className={cn('w-full border-collapse text-[0.9375rem]', className)}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        {printHeading && (
          <tr className="hidden print:table-row">
            <td colSpan={columns.length} className="pb-3 text-start">
              {printHeading}
            </td>
          </tr>
        )}
        <tr className="border-b-2">
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              aria-sort={column.sort ? (column.sort.direction ?? 'none') : undefined}
              className={cn(column.sort ? 'px-1 py-0' : 'px-3 py-2', 'font-semibold', align(column), column.className)}
            >
              {column.sort ? <SortHeading column={{ ...column, sort: column.sort }} /> : column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={getRowKey(row)} className="border-b">
            {columns.map((column) => (
              <td key={column.key} className={cn('px-3 py-3 align-top', align(column), column.className)}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
