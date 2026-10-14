import * as React from 'react'
import { cn } from '@/lib/utils'

// A progress bar written by hand in shadcn's style (its slots, its track and fill), not copied from the CLI: shadcn's is a Radix primitive, and a
// div with four ARIA attributes does not need a dependency (AGENTS.md). The track and the fill are separate elements, so a colour goes on the
// fill (`indicatorClassName`) and the track keeps its own. Name it with `aria-label` or `aria-labelledby`, and say its value in words with `valueText`.
function Progress({
  className,
  indicatorClassName,
  value,
  valueText,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** How full, 0 to 100. Anything outside that is drawn at the nearest end. */
  value: number
  /** The value as a screen reader says it ("1,234,567 of 5,000,000 rows read, 24%"). */
  valueText?: string
  indicatorClassName?: string
}) {
  const filled = Math.min(100, Math.max(0, value))
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={filled}
      aria-valuetext={valueText}
      className={cn('relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn('size-full flex-1 bg-primary transition-all', indicatorClassName)}
        style={{ transform: `translateX(-${100 - filled}%)` }}
      />
    </div>
  )
}

export { Progress }
