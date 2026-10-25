import { dayLimitResets } from '@/lib/member-busy'

/**
 * Over a Member's page once a read has been refused for the Members' daily read limit (src/lib/member-busy.ts `useDayLimitReached`): why the page's reads fail, and when
 * they work again. It sits where the sign-in banner does and looks the same. The reads that draw the shell (`/api/me`, `/api/settings`, `/api/features`) are never refused, so
 * it always has a page to sit on.
 */
export function DayLimitBanner() {
  return (
    <div role="alert" className="sticky top-(--header-height) z-40 mb-4 rounded-lg border-2 border-warning bg-background p-4 text-foreground print:hidden">
      <p className="font-medium">Today's limit on Members' reads has been reached, so some of this page couldn't load. It starts again at {dayLimitResets()} (New Zealand time).</p>
    </div>
  )
}
