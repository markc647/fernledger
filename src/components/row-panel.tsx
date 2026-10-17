import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const FIELD = 'input, select, textarea'

/**
 * The field that had focus when a panel was taken away with focus in it, by the panel's `id`, for the panel that replaces it in the same commit: the table becoming cards (or the other way) draws the panel again, and
 * the reader finds themselves in the box they were typing in. It is forgotten at once (a timer, after the commit) if no panel takes it, so it is never found by a panel opened later.
 */
const HAD_FOCUS = new Map<string, string>()

/**
 * The panel that a row's one action opens (Edit a Transaction's Category and Note, Rename an Account, Edit a Budget): a stock shadcn Card, a region named by its `h2`, with the form in it. In a table it is the
 * `expanded` row of `ResponsiveTable` (src/components/responsive-table.tsx), directly under its row and across the table, so it has the width of the table (the form inside keeps a width a line of text reads well in).
 * What the app needs on top of the Card is on this one card and not in `ui/card.tsx`, as in `DashboardCard`: a border as well as the stock ring, which is a shadow that Windows high contrast removes, no
 * `overflow-hidden`, which would hide a long word the page's checks should see, and `min-w-0`, so a card in a cell shrinks to it.
 *
 * When it opens, focus goes to its first field (or the one that had it, if this panel replaces one drawn again) without the browser scrolling to it, which centres a field that is below the fold, and so jumps a page
 * whose row is near the bottom. The panel and its row are then brought into view by the least scrolling there is, and only if some of them are off the screen or under the sticky header (the page's `scroll-padding-top`);
 * a panel too tall for the room has its row at the top.
 * `id` is what its row's button `aria-controls`, what `focusPanel` finds, and what the field that had focus is kept under.
 */
export function RowPanel({ id, title, className, children }: { id?: string; title: string; className?: string; children: ReactNode }) {
  const headingId = useId()
  const card = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panel = card.current
    if (!panel) return
    const had = id ? HAD_FOCUS.get(id) : undefined
    if (id) HAD_FOCUS.delete(id)
    const field = (had ? panel.querySelector<HTMLElement>(`#${CSS.escape(had)}`) : null) ?? panel.querySelector<HTMLElement>(FIELD)
    field?.focus({ preventScroll: true })
    // The page keeps room under the sticky header for whatever the browser scrolls into view, and a row or a panel under it is as much off the screen as one below the window. What the reader pressed is the row
    // (or card) the panel is under, so it stays on the screen with the panel: by the least scrolling there is if both fit in the room there is, and if they do not, with the row at the top and as much of the panel
    // as fits under it (the browser's own `nearest` would show the foot of a panel that is too tall and leave its row under the header).
    const under = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
    const box = panel.getBoundingClientRect()
    const from = (panel.closest('tr, li')?.previousElementSibling ?? panel).getBoundingClientRect().top
    if (from < under || box.bottom > window.innerHeight) {
      const fits = box.bottom - from <= window.innerHeight - under
      window.scrollBy({ top: fits && from >= under ? box.bottom - window.innerHeight : from - under })
    }
    return () => {
      // The cleanup runs before the field is taken out of the page, so it is still the one with focus.
      const focused = document.activeElement
      if (!id || !(focused instanceof HTMLElement) || !focused.id || !panel.contains(focused)) return
      HAD_FOCUS.set(id, focused.id)
      setTimeout(() => HAD_FOCUS.delete(id), 0)
    }
  }, [id])
  return (
    <Card ref={card} id={id} role="region" aria-labelledby={headingId} className={cn('min-w-0 overflow-visible border ring-0', className)}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold [overflow-wrap:anywhere]">
          <h2 id={headingId}>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-xl">{children}</div>
      </CardContent>
    </Card>
  )
}

/** Pressing the button of a row whose panel is already open puts focus in the panel, on its first field. */
export function focusPanel(id: string) {
  document.getElementById(id)?.querySelector<HTMLElement>(FIELD)?.focus()
}

/** What the page keeps of the panels' drafts (`useDrafts`). */
export type Drafts<Draft> = { get: (id: string | number) => Draft | undefined; set: (id: string | number, draft: Draft | null) => void }

/**
 * What the Admin has typed into the panels of rows and not saved, by row, for as long as the page is open: opening another row's panel, going to another page of the list, or the table becoming cards (or the
 * other way) all start a panel again, and what was typed in the first is not lost. A panel is given the store and its row's id, and starts from `get(id)` when it opens (not from a value the page read when it
 * last drew, which a table that changes layout by itself would hand it stale), says what it holds with `set(id, draft)` (`null` when it holds nothing that is not saved), and the page `set`s `null` on Save and on Cancel.
 */
export function useDrafts<Draft>(): Drafts<Draft> {
  const drafts = useRef(new Map<string | number, Draft>())
  return useMemo(
    () => ({
      get: (id) => drafts.current.get(id),
      set: (id, draft) => {
        if (draft === null) drafts.current.delete(id)
        else drafts.current.set(id, draft)
      },
    }),
    [],
  )
}
