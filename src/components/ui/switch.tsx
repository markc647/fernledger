import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui Switch, as a plain button with role="switch" rather than Radix's (CODING_STANDARDS.md: add a dependency only when a few lines can't do
// the job): a button already takes focus and Space and Enter, and `aria-checked` says whether it is on. The button is 44px tall, as the app's other
// controls are, with the track drawn inside it; the track is outlined, so it can be seen against the page when it is off (3:1 for a control's edge).

function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onClick' | 'role'> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  const state = checked ? 'checked' : 'unchecked'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-state={state}
      onClick={() => onCheckedChange(!checked)}
      className={cn('group inline-flex min-h-11 shrink-0 items-center rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50', className)}
      {...props}
    >
      <span
        data-slot="switch-track"
        className="inline-flex h-7 w-12 items-center rounded-full border-2 border-foreground/60 bg-background p-0.5 transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary"
      >
        <span
          data-slot="switch-thumb"
          className="pointer-events-none block size-5 rounded-full bg-foreground/60 transition-transform motion-reduce:transition-none group-data-[state=checked]:translate-x-5 group-data-[state=checked]:bg-primary-foreground"
        />
      </span>
    </button>
  )
}

export { Switch }
