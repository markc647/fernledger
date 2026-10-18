import { useQuery } from '@tanstack/react-query'
import { FILL, TONE } from '@/components/d1-usage-bar'
import { Badge } from '@/components/ui/badge'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { allowanceLeft, ESTIMATE_NOTE, resetSentence, type LeftLevel } from '@/lib/d1-usage'
import { d1AllowanceQuery } from '@/lib/d1-usage-query'
import { featuresQuery } from '@/lib/features'

// The bar is green with plenty left, amber below 20% and red below 5%: the colours of the D1 usage bar's Low, Medium and High, which are about what is used and not what is left.
const LEVEL = { plenty: 'low', low: 'medium', 'almost-used': 'high' } as const satisfies Record<LeftLevel, keyof typeof FILL>

/**
 * Whether the header shows the free allowance bar: for the Admin alone, and once the D1 usage bar is set up (docs/setup.md; the same feature check as the Rules page's). A Member, and
 * an Admin who has not turned it on, make no request for the figures, and the Member's header makes none for the features either.
 */
export function useAllowanceOn(admin: boolean) {
  const { data: features } = useQuery({ ...featuresQuery, enabled: admin })
  return admin && features?.find((candidate) => candidate.id === 'd1-usage')?.enabled === true
}

/**
 * How much of today's free database allowance is left, in the Admin's header on every page: one bar, of whichever of the rows read (5,000,000 a day) and the rows written (100,000)
 * has less, with the word Low or Almost used when it is running out, so the colour is not the only cue. It is an estimate, because Cloudflare's figures run a few minutes behind,
 * and says so. Both figures are in a tooltip that opens on hover and on keyboard focus (the bar can be tabbed to), and in what a screen reader says for the bar's value; in the
 * phone's menu (`menu`) they are written under it, because a touch screen has no hover. It never raises an alert: if the figures cannot be had it says "Allowance unknown". The Rules
 * page's own question reads the figures afresh each time it opens (`d1UsageQuery`); this is read every few minutes (`d1AllowanceQuery`). Mounted only while `useAllowanceOn`.
 */
export function AllowanceBar({ layout }: { layout: 'bar' | 'menu' }) {
  const usage = useQuery(d1AllowanceQuery)

  // Checked before the data: a refresh that failed leaves the last figures in the query, and after midnight UTC they are yesterday's.
  if (usage.isError) return <p className="whitespace-nowrap text-muted-foreground">Allowance unknown</p>
  if (!usage.data) return null

  const left = allowanceLeft(usage.data)
  // As wide as its words in the header (`w-max`: they do not wrap, and the header made room for them); the width of the menu in the menu.
  const bar = (
    <Progress
      value={left.percent}
      valueText={left.valueText}
      tabIndex={layout === 'bar' ? 0 : undefined}
      className={layout === 'bar' ? 'w-max rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring' : undefined}
      trackClassName="h-2.5 border border-muted-foreground"
      indicatorClassName={FILL[LEVEL[left.level]]}
    >
      <ProgressLabel>Free allowance left today</ProgressLabel>
      <ProgressValue className="flex items-center gap-2">
        about {left.percent}%
        {left.word && (
          <Badge variant={TONE[LEVEL[left.level]]} className="min-h-0 py-0">
            {left.word}
          </Badge>
        )}
      </ProgressValue>
    </Progress>
  )
  if (layout === 'menu') {
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
    <Tooltip>
      <TooltipTrigger asChild>{bar}</TooltipTrigger>
      <TooltipContent className="space-y-1">
        <p>{left.figures[0]}</p>
        <p>{left.figures[1]}</p>
        <p>{ESTIMATE_NOTE}</p>
        <p>{resetSentence(usage.data)}</p>
      </TooltipContent>
    </Tooltip>
  )
}
