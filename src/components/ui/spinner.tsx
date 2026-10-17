import * as React from 'react'
import { Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'

// shadcn/ui Spinner, as the registry writes it (lucide's Loader2Icon turning, announced as "Loading"), with `motion-reduce:animate-none` added: a spinner that
// turns without end is the kind of motion a device's reduced-motion setting asks to be rid of (README, Accessibility). It then stands still, and "Loading" is
// still what a screen reader says.
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <Loader2Icon role="status" aria-label="Loading" className={cn('size-4 animate-spin motion-reduce:animate-none', className)} {...props} />
}

export { Spinner }
