import { useQuery } from '@tanstack/react-query'
import { OctagonAlert, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { allowanceLeft, ESTIMATE_NOTE, FILL, resetSentence, TONE, type Level } from '@/lib/d1-usage'
import { d1AllowanceQuery } from '@/lib/d1-usage-query'
import { featuresQuery } from '@/lib/features'
import { settingsQuery } from '@/lib/settings'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'

/** What stands for the word where there is no room for it (the compact header): a different shape for each colour, so the colour is not the only cue. Said in words by the bar's value text and its tooltip. */
const ICON: Partial<Record<Level, { Icon: typeof TriangleAlert; colour: string }>> = {
  low: { Icon: TriangleAlert, colour: 'text-warning' },
  almost: { Icon: OctagonAlert, colour: 'text-danger' },
  'used-up': { Icon: OctagonAlert, colour: 'text-danger' },
}

/** The words of the bar's name: its label where there is room for it (in the menu, and in a header wide enough), and otherwise its accessible name and the first line of its tooltip. */
const LABEL = 'Free allowance left today'

/**
 * Whether the header shows the free allowance bar: for the Admin alone, and once the D1 usage bar is set up (docs/setup.md; the same feature check as the Rules page's). A Member, and
 * an Admin who has not turned it on, make no request for the figures, and the Member's header makes none for the features either.
 */
export function useAllowanceOn(admin: boolean) {
  const { data: features } = useQuery({ ...featuresQuery, enabled: admin })
  // The bar is what is left of a Free Plan day, so it is not shown on the Paid Plan (ADR 0018). Settings that can't be read leave it as it was on Free.
  const { data: settings } = useQuery(settingsQuery)
  return admin && settings?.cloudflare_plan !== 'paid' && features?.find((candidate) => candidate.id === 'd1-usage')?.enabled === true
}

/**
 * How much of today's free database allowance is left, in the Admin's header on every page: one bar, of whichever of the rows read (5,000,000 a day) and the rows written (100,000)
 * has gone further, with its colour and a word (Running low, Almost used, Used up) when it is going, as the Rules page's bars say of the same figures (src/lib/d1-usage.ts). It is an
 * estimate, because Cloudflare's figures run a few minutes behind, and says so ("about").
 *
 * In the header it is compact, the bar and its value, because the controls are there too: the words "Free allowance left today" are the bar's name for a screen reader and the first line of its
 * tooltip, and are written out beside it only where the header has room (from 86rem). Both figures are in the tooltip, which opens on hover, on keyboard focus (the bar is a tab stop), and on a
 * tap on a touch screen, and in what a screen reader says for the bar's value. In the phone's menu (`menu`) the words and both figures are written out under it. It never raises an alert: if
 * the figures cannot be had it says "Allowance unknown". The Rules page's own question reads the figures afresh each time it opens (`d1UsageQuery`); this is read every few minutes
 * (`d1AllowanceQuery`). Mounted only while `useAllowanceOn`.
 */
export function AllowanceBar({ layout }: { layout: 'bar' | 'menu' }) {
  const usage = useQuery(d1AllowanceQuery)
  const touch = useMediaQuery('(any-pointer: coarse)') // a touch screen, even where a mouse is the main pointer (a laptop's)
  const [open, setOpen] = useState(false)

  // Checked before the data: a refresh that failed leaves the last figures in the query, and after midnight UTC they are yesterday's.
  if (usage.isError) return <p className="whitespace-nowrap text-muted-foreground">Allowance unknown</p>
  if (!usage.data) return null

  const left = allowanceLeft(usage.data)
  const inBar = layout === 'bar'
  const icon = ICON[left.level]
  // As wide as its value in the header (`w-max`: nothing wraps, and the header has made room for it); the width of the menu in the menu. A touch screen has a target of 44px (any pointer that is coarse, as a laptop's touch screen is beside its mouse).
  const bar = (
    <Progress
      value={left.percent}
      valueText={left.valueText}
      tabIndex={inBar ? 0 : undefined}
      className={inBar ? 'w-max rounded-md any-pointer-coarse:min-h-11 any-pointer-coarse:content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring' : undefined}
      trackClassName="h-2.5 border border-muted-foreground"
      indicatorClassName={FILL[left.level]}
    >
      <ProgressLabel className={inBar ? 'sr-only @min-[86rem]/header:not-sr-only' : undefined}>{LABEL}</ProgressLabel>
      <ProgressValue className="flex items-center gap-2">
        about {left.percent}%
        {inBar && icon && <icon.Icon aria-hidden className={cn('size-4 @min-[86rem]/header:hidden', icon.colour)} />}
        <Badge variant={TONE[left.level]} className={cn('min-h-0 py-0', inBar && 'hidden @min-[86rem]/header:inline-flex')}>
          {left.word}
        </Badge>
      </ProgressValue>
    </Progress>
  )
  if (!inBar) {
    return (
      <div className="flex flex-col gap-1">
        {bar}
        <p className="text-muted-foreground">{left.figures[0]}</p>
        <p className="text-muted-foreground">{left.figures[1]}</p>
        <p className="text-muted-foreground">{ESTIMATE_NOTE}</p>
      </div>
    )
  }
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      {/* On a touch screen there is no hover, so a tap opens it (it may already be, if the tap focused the bar), and a tap elsewhere shuts it. (On the trigger and not on the bar: the trigger's
          own click shuts the tooltip unless this has handled it.) */}
      <TooltipTrigger
        asChild
        onClick={(event) => {
          if (!touch) return
          event.preventDefault()
          setOpen(true)
        }}
      >
        {bar}
      </TooltipTrigger>
      <TooltipContent className="space-y-1">
        <p className="font-medium">{LABEL}</p>
        <p>{left.word}</p>
        <p>{left.figures[0]}</p>
        <p>{left.figures[1]}</p>
        <p>{ESTIMATE_NOTE}</p>
        <p>{resetSentence(usage.data)}</p>
      </TooltipContent>
    </Tooltip>
  )
}
