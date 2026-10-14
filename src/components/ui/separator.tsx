import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui Separator, trimmed to the one line the app draws, a vertical one for the eye between the sidebar toggle and the breadcrumb, so it is a plain element rather than
// Radix's (CODING_STANDARDS.md: add a dependency only when a few lines can't do the job). Hidden from assistive technology: it says nothing the controls beside it don't.

function Separator({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="separator" aria-hidden="true" className={cn('h-full w-px shrink-0 bg-border', className)} {...props} />
}

export { Separator }
