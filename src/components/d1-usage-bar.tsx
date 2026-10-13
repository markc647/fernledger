import { queryOptions, useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api } from '@/lib/api'
import { LEVEL_WORDS, meters, resetSentence, setupPointer, staleNote, unavailableNote, type D1Usage, type Level, type Meter } from '@/lib/d1-usage'
import { featuresQuery } from '@/lib/features'
import { HttpError } from '@/lib/me'
import { cn } from '@/lib/utils'

/**
 * Today's D1 rows read and written for the whole Cloudflare account (worker/d1-usage.ts). It loads when the panel shows and when the page
 * says to (after a run of the Rules ends or pauses): no timer, no refetch when the window is focused, and no retry, so a failure shows at once.
 * It asks only when the feature is set up (D1_USAGE in worker/features.ts), so a Deployer who hasn't turned it on makes no request.
 */
export const d1UsageQuery = queryOptions({
  queryKey: ['d1-usage'],
  queryFn: async (): Promise<D1Usage> => {
    const res = await api['d1-usage'].$get()
    if (!res.ok) throw new HttpError(res.status)
    return res.json()
  },
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
})

// The same three colours as the Status component (the --success, --warning and --danger tokens, each pinned in scripts/theme-contrast.test.mjs
// at 4.5:1 against the page, a card and the muted fill in both themes, so 3:1 for a graphic is met too). Colour is never the only signal:
// the badge says Low, Medium or High in words, the figures are written under the bar, and the bar has a border, so Windows high contrast,
// which removes fills, still shows how full it is (CanvasText for the fill there).
const BAR: Record<Level, string> = {
  low: 'bg-success forced-colors:bg-[CanvasText]',
  medium: 'bg-warning forced-colors:bg-[CanvasText]',
  high: 'bg-danger forced-colors:bg-[CanvasText]',
}
const BADGE: Record<Level, string> = { low: 'border-success text-success', medium: 'border-warning text-warning', high: 'border-danger text-danger' }

/**
 * The Admin's D1 usage, in the "Apply the Rules to all Transactions" panel: rows read and rows written today against the free plan's
 * allowance. It is laid out as shadcn's Progress example 7: a label and a badge, the bar, then the figures and the percentage.
 */
export function D1UsageBar() {
  const { data: features } = useQuery(featuresQuery)
  const feature = features?.find((candidate) => candidate.id === 'd1-usage')
  const on = feature?.enabled === true
  const usage = useQuery({ ...d1UsageQuery, enabled: on })
  const heading = useId()

  // Nothing until the Worker has said whether it is set up, and nothing if it could not say: the panel is complete without this.
  if (!feature) return null
  return (
    <section aria-labelledby={heading} className="mt-3">
      <h3 id={heading} className="font-medium">
        Free database allowance
      </h3>
      {!on ? (
        // Setup needed (GLOSSARY): optional, so it reads as an offer and not a fault. The words are the Worker's, written from the declaration.
        <>
          <p className="mt-1">{feature.message}</p>
          <p className="mt-1">{setupPointer()}</p>
        </>
      ) : usage.data ? (
        <>
          {meters(usage.data).map((meter, i) => (
            <UsageMeter key={meter.label} meter={meter} thin={i === 1} />
          ))}
          <p className="mt-2">{resetSentence(usage.data)}</p>
          <p className="mt-1 text-muted-foreground">{staleNote()}</p>
        </>
      ) : usage.isError ? (
        <div role="status" className="mt-1 space-y-2">
          <p>{unavailableNote()}</p>
          <Button size="touch" variant="outline" disabled={usage.isFetching} onClick={() => void usage.refetch()}>
            Check again
          </Button>
        </div>
      ) : (
        <p role="status" className="mt-1">
          Checking today's database usage…
        </p>
      )}
    </section>
  )
}

function UsageMeter({ meter, thin }: { meter: Meter; thin: boolean }) {
  const label = useId()
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span id={label} className="font-medium">
          {meter.label}
        </span>
        <Badge variant="outline" className={cn('h-auto min-h-6 px-2.5 text-base', BADGE[meter.level])}>
          {LEVEL_WORDS[meter.level]}
        </Badge>
      </div>
      <Progress
        aria-labelledby={label}
        value={meter.value}
        getValueLabel={() => meter.valueText}
        className={cn('mt-1 border border-muted-foreground', thin ? 'h-2' : 'h-3')}
        indicatorClassName={BAR[meter.level]}
      />
      <p className="mt-1">{meter.text}</p>
    </div>
  )
}
