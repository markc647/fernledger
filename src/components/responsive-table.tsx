import { useId, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
  /** For a column that is empty for some rows (a Note that is not there): a row it returns true for has no line for this column on its card. The table keeps the cell, which is empty. */
  hideOnCard?: (row: Row) => boolean
  /**
   * The column holds the grip that drags its row (see `RowElement`). In the table it is the first column, narrow, with `header` read by a screen reader and not drawn. A card has no label for it:
   * it sits at the start of the card, beside the lines. At most one column has it.
   */
  handle?: boolean
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

/** What `RowElement` is given: the row's key, which layout it is in, the classes the row would have had, and what goes inside (the cells, or the card's lines). */
export type RowProps = { rowKey: string | number; layout: 'table' | 'cards'; className?: string; children: ReactNode }

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

/** The heading and cells of a handle column: narrow, with its padding to the start. */
const HANDLE_CELL = 'w-12 py-2 ps-2 pe-0'

// The table's look on screen is one set of classes, here, for every table. On paper (`print:`) it is the paper layout a Report is printed in: no box (the frame's border, corners and clipping, and
// the scrolling of the table's container), no shading, a 2px rule under the headings (and none under the printed heading above them) and a divider under every row, the last too, with the text at the top of its cell.
// A column's own `className` is last, so a Report's tighter padding on paper (`PAPER`, src/lib/utils.ts) still wins. `!` is for the rules that ui/table.tsx writes with a selector of its own (`[&_tr]`).

/** The box round the table: rounded and clipped to its corners, and, on paper, neither, and the table inside it no longer scrolls. */
const FRAME = 'overflow-hidden rounded-lg print:overflow-visible print:rounded-none [&_[data-slot=table-container]]:print:overflow-visible'
/** The heading rows: shaded on screen, with a divider under each; on paper unshaded, with the rule under the headings only. */
const HEADER = 'bg-muted print:bg-transparent print:[&_tr]:border-b-0! print:[&_tr:last-child]:border-b-2!'
/** The rows: the last has no divider on screen, where the box closes it; on paper it has. */
const BODY = 'print:[&_tr:last-child]:border-b!'

/** A card, when the page has not given its rows an element of their own. */
const CardItem = ({ className, children }: RowProps) => <li className={className}>{children}</li>
/** A row of the shadcn table, likewise. */
const TableItem = ({ className, children }: RowProps) => <TableRow className={className}>{children}</TableRow>

/**
 * Data as a table on a wide screen and as one card per row on a narrow one (below 768px, which is also what a phone,
 * or a desktop browser at 200% zoom, looks like), so nothing ever scrolls sideways. Its text is the page's size, whatever the text size (README, Accessibility).
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
  look = 'shadcn',
  RowElement,
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
  /**
   * Every table on screen has one look, shadcn/ui's Table: a muted heading row, a divider between rows and a row that lights as it is pointed at, in a rounded box. The cards a phone gets are the
   * same whatever the look. `shadcn`, the default, draws the box with its border. `in-card` is for a table that sits in a card (the Summary's and the Dashboard's), which is the box already: the same
   * heading and rows without a second border. On paper neither is drawn: a table is the paper layout (no box, no shading, a rule under its headings, a divider under every row), whatever its look.
   */
  look?: 'shadcn' | 'in-card'
  /**
   * The element of a row, for a page that makes its rows more than a row (draggable: src/components/sortable-rows.tsx). A stable component, not one made in the page's render, which would
   * start every row again each time. It draws a `tr` (`TableRow`) or an `li` according to `layout`.
   */
  RowElement?: ComponentType<RowProps>
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
    const handle = columns.find((column) => column.handle)
    const Item = RowElement ?? CardItem
    return (
      <>
        <SortMenu columns={columns} />
        {/* One column that may shrink to the window: without it a card is as wide as its longest unbroken word (a long web address in a Note). */}
        <ul aria-label={caption} className="grid grid-cols-1 gap-3 text-base">
          {rows.map((row) => (
            <Item
              key={getRowKey(row)}
              rowKey={getRowKey(row)}
              layout="cards"
              className={cn('rounded-xl border bg-card p-4 text-card-foreground', handle && 'flex items-start gap-1')}
            >
              {/* The grip, if the page has one, at the card's start: the card's lines (a label with its value) are beside it. */}
              {handle && <div className="-my-1 -ms-3 shrink-0">{handle.cell(row)}</div>}
              <dl className={cn('grid grid-cols-1 gap-2', handle && 'min-w-0 grow')}>
                {/* A label and a value sit side by side, the value taking the rest of the line, unless the value's narrowest form (a large amount that keeps its digits together, or a long
                    word) will not fit beside the label: then, at any text size, it goes under the label, and a label wider than the card wraps, rather than push the page wider.
                    Ordinary content at the usual text size is where it always was; a row changes only when its value could not fit. */}
                {columns
                  .filter((column) => !column.handle && !column.hideOnCard?.(row))
                  .map((column) => (
                    <div key={column.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <dt className="text-muted-foreground">{column.header}</dt>
                      <dd className="min-w-0 grow basis-[min-content] text-end break-words">{column.cell(row)}</dd>
                    </div>
                  ))}
              </dl>
            </Item>
          ))}
        </ul>
      </>
    )
  }
  const Item = RowElement ?? TableItem
  return (
    // The box is the shadcn data table's: rounded, with a border the heading and rows sit inside, or, in a card, without one.
    <div data-slot="table-frame" className={cn(FRAME, look === 'shadcn' && 'border print:border-0')}>
      <Table className={cn('text-base', className)}>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className={HEADER}>
          {printHeading && (
            <tr className="hidden print:table-row">
              <td colSpan={columns.length} className="pb-3 text-start">
                {printHeading}
              </td>
            </tr>
          )}
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead
                key={column.key}
                scope="col"
                aria-sort={column.sort ? (column.sort.direction ?? 'none') : undefined}
                className={cn(column.handle ? HANDLE_CELL : column.sort ? 'px-1 py-1' : 'px-3 py-2', 'font-semibold whitespace-normal print:h-auto', align(column), column.className)}
              >
                {column.handle ? <span className="sr-only">{column.header}</span> : column.sort ? <SortHeading column={{ ...column, sort: column.sort }} /> : column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className={BODY}>
          {rows.map((row) => (
            <Item key={getRowKey(row)} rowKey={getRowKey(row)} layout="table">
              {columns.map((column) => (
                <TableCell key={column.key} className={cn(column.handle ? HANDLE_CELL : 'px-3 py-2', 'whitespace-normal print:align-top', align(column), column.className)}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </Item>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
