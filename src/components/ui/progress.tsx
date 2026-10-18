import * as React from 'react'
import { cn } from '@/lib/utils'

// A progress bar written by hand in shadcn's style (its slots: the root with a label and a value, a track and an indicator), not copied from the CLI: shadcn's is a Radix primitive,
// and a div with four ARIA attributes does not need a dependency (CODING_STANDARDS.md, Dependencies). Like shadcn's, the root is the progressbar and holds the label and the value
// as its children, and draws the track after them, so `<Progress value={56}><ProgressLabel>Upload progress</ProgressLabel><ProgressValue /></Progress>` is a named bar with its value
// beside the name. The track and the fill are separate elements, so a colour goes on the fill (`indicatorClassName`) and the track keeps its own (`trackClassName`). A bar with no
// ProgressLabel is named with `aria-label` or `aria-labelledby`. Say its value in words with `valueText`.

const ProgressContext = React.createContext<{ value: number; labelId: string; labelled: (is: boolean) => void } | null>(null)
const useProgress = () => React.useContext(ProgressContext)!

function Progress({
  className,
  trackClassName,
  indicatorClassName,
  value,
  valueText,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** How full, 0 to 100. Anything outside that is drawn at the nearest end. */
  value: number
  /** The value as a screen reader says it ("1,234,567 of 5,000,000 rows read, 24%"). */
  valueText?: string
  trackClassName?: string
  indicatorClassName?: string
}) {
  const filled = Math.min(100, Math.max(0, value))
  const labelId = React.useId()
  const [labelled, setLabelled] = React.useState(false)
  return (
    <ProgressContext value={{ value: filled, labelId, labelled: setLabelled }}>
      <div
        data-slot="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={filled}
        aria-valuetext={valueText}
        aria-labelledby={labelled ? labelId : undefined}
        className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1', className)}
        {...props}
      >
        {children}
        <div data-slot="progress-track" className={cn('relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted', trackClassName)}>
          <div
            data-slot="progress-indicator"
            className={cn('size-full flex-1 bg-primary transition-all', indicatorClassName)}
            style={{ transform: `translateX(-${100 - filled}%)` }}
          />
        </div>
      </div>
    </ProgressContext>
  )
}

/** The bar's name. It is what the bar is labelled by, so it must be words and not an icon. */
function ProgressLabel({ className, ...props }: React.ComponentProps<'span'>) {
  const { labelId, labelled } = useProgress()
  React.useEffect(() => {
    labelled(true)
    return () => labelled(false)
  }, [labelled])
  return <span data-slot="progress-label" id={labelId} className={cn('font-medium', className)} {...props} />
}

/** The value beside the name: the bar's value as a whole per cent unless it is given words. */
function ProgressValue({ className, children, ...props }: React.ComponentProps<'span'>) {
  const { value } = useProgress()
  return (
    <span data-slot="progress-value" className={cn('ms-auto tabular-nums', className)} {...props}>
      {children ?? `${Math.round(value)}%`}
    </span>
  )
}

export { Progress, ProgressLabel, ProgressValue }
