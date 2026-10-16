import type { ReactNode, Ref } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The Summary and the Dashboard are a column of cards (shadcn's dashboard-01, without its table), each a whole row: a table the width of Balances's needs the room, and `ResponsiveTable`
// chooses a table or cards from the window and not from its card, so a card that shared a row with another would have to have room for its columns.

/** The column the cards sit in. Its cards are its direct children, in the order they are read. */
export function SummaryGrid({ children }: { children: ReactNode }) {
  return <div className="mt-6 grid grid-cols-1 gap-4">{children}</div>
}

/**
 * One card of the Summary, the Dashboard or the Net worth page: a region named by its heading (an `h2`, under the page's `h1`), with an optional line of explanation under it, and its content.
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
  busy,
  headingRef,
  children,
}: {
  headingId: string
  title: string
  description?: ReactNode
  /** `aria-busy` for a card that loads or updates after the page is up. */
  busy?: boolean
  headingRef?: Ref<HTMLHeadingElement>
  children: ReactNode
}) {
  return (
    <Card role="region" aria-labelledby={headingId} aria-busy={busy} className="min-w-0 overflow-visible border ring-0">
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
