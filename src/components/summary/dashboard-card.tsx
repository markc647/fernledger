import type { ReactNode, Ref } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The Summary and the Dashboard are a grid of cards (shadcn's dashboard-01, without its table). The grid is one column until the page's panel is wide enough for two cards to sit
// side by side and still show a table (`ResponsiveTable` chooses a table or cards from the window, not the card, so a card that shares a row needs room for its columns), and then it has
// six, so a card can be a third, a half, two thirds or all of a row. The width is a container query in rem, so it follows the text size: at Xtra Large the same panel
// holds fewer columns, as it should.
const SPANS = {
  third: '@4xl/summary:col-span-2',
  half: '@4xl/summary:col-span-3',
  'two-thirds': '@4xl/summary:col-span-4',
  full: '@4xl/summary:col-span-6',
} as const

type CardSpan = keyof typeof SPANS

/** The classes that give something in the grid (a note that stands in for cards still to come) the width of a card of that span. */
export const spanClass = (span: CardSpan) => SPANS[span]

/** The grid the cards sit in. Its cards are its direct children, in the order they are read. */
export function SummaryGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container/summary mt-6">
      <div className="grid grid-cols-1 gap-4 @4xl/summary:grid-cols-6">{children}</div>
    </div>
  )
}

/**
 * One card of the Summary or the Dashboard: a region named by its heading (an `h2`, under the page's `h1`), with an optional line of explanation under it, and its content.
 * Stock shadcn Card, with what the app needs on top of it, on this one card and not in the Card:
 * - a border, as well as the stock ring, which is a shadow that Windows high contrast removes, so a card keeps its edge;
 * - no `overflow-hidden`, which would hide a long word or a wide amount that does not fit rather than let the page's checks see it;
 * - `min-w-0`, so a grid cell shrinks to its column instead of growing to its widest content.
 * `headingRef` is for a card whose button takes itself away: focus goes to the heading it sat under.
 */
export function DashboardCard({
  headingId,
  title,
  description,
  span = 'full',
  busy,
  headingRef,
  children,
}: {
  headingId: string
  title: string
  description?: ReactNode
  span?: CardSpan
  /** `aria-busy` for a card that loads or updates after the page is up. */
  busy?: boolean
  headingRef?: Ref<HTMLHeadingElement>
  children: ReactNode
}) {
  return (
    <Card role="region" aria-labelledby={headingId} aria-busy={busy} className={`min-w-0 overflow-visible border ring-0 ${spanClass(span)}`}>
      <CardHeader>
        <CardTitle className="text-xl font-semibold">
          <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {title}
          </h2>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
