import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { FILL, LEVEL_WORDS, meters, resetSentence, STALE_NOTE, TONE, unavailableNote, type Meter } from '@/lib/d1-usage'
import { d1UsageQuery } from '@/lib/d1-usage-query'
import { featuresQuery } from '@/lib/features'
import { HttpError } from '@/lib/me'

/**
 * The Admin's D1 usage, in two places on the Rules page: the question that opens before the Rules are applied to all Transactions (an alert dialog), and the frame of a run that is
 * paused for the allowance (the button that opens the question is off while a run is going). It is read when it shows, in either, and not while it is shut or the run is working: rows
 * read and rows written today against the free plan's
 * allowance, each a label and a badge (Plenty left, Running low, Almost used or Used up: the header's bar has the same words and colours for the same figures, src/lib/d1-usage.ts),
 * the bar, then the figures and the percentage. When Cloudflare gave no figures, the panel says so and no
 * bars are drawn, so figures from before a failed refresh are not shown as today's.
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
      <h3 id={heading} className="text-lg font-medium">
        Free database allowance
      </h3>
      {!on ? (
        // Setup needed (GLOSSARY): optional, so it reads as an offer and not a fault. The words, the steps included, are the Worker's.
        <p className="mt-1">{feature.message}</p>
      ) : usage.isError ? (
        // Checked before the data: a refresh that failed leaves the last figures in the query, and they are not today's.
        <div role="status" className="mt-1 space-y-2">
          <p>{unavailableNote(usage.error instanceof HttpError ? usage.error.reason : undefined)}</p>
          <Button size="touch" variant="outline" disabled={usage.isFetching} onClick={() => void usage.refetch()}>
            Check again
          </Button>
        </div>
      ) : usage.data ? (
        <>
          {meters(usage.data).map((meter) => (
            <UsageMeter key={meter.label} meter={meter} />
          ))}
          <p className="mt-2">{resetSentence(usage.data)}</p>
          <p className="mt-1 text-muted-foreground">{STALE_NOTE}</p>
        </>
      ) : (
        <p role="status" className="mt-1">
          Checking today's database usage…
        </p>
      )}
    </section>
  )
}

function UsageMeter({ meter }: { meter: Meter }) {
  const label = useId()
  return (
    <div role="group" aria-labelledby={label} className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span id={label} className="font-medium">
          {meter.label}
        </span>
        <Badge variant={TONE[meter.level]}>{LEVEL_WORDS[meter.level]}</Badge>
      </div>
      <Progress aria-labelledby={label} value={meter.percent} valueText={meter.valueText} className="mt-1" trackClassName="h-3 border border-muted-foreground" indicatorClassName={FILL[meter.level]} />
      <p className="mt-1">{meter.text}</p>
    </div>
  )
}
