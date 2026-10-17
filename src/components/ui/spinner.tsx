import * as React from 'react'
import { Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'

// shadcn/ui Spinner, as the registry writes it: lucide's Loader2Icon turning, announced as "Loading". Under a device's reduced-motion setting it stands still without a class of its
// own: src/index.css gives every animation no time and one turn there, so the spin ends at once where it began (README, Accessibility). "Loading" is still what a screen reader says.
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <Loader2Icon role="status" aria-label="Loading" className={cn('size-4 animate-spin', className)} {...props} />
}

export { Spinner }
