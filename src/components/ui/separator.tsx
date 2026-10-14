import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui Separator, trimmed to a line the app only draws for the eye (between the sidebar toggle and the breadcrumb), so it is a plain element rather than Radix's
// (CODING_STANDARDS.md: add a dependency only when a few lines can't do the job). Hidden from assistive technology: it says nothing the controls beside it don't.

function Separator({ className, orientation = 'horizontal', ...props }: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      aria-hidden="true"
      className={cn('shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px', className)}
      {...props}
    />
  )
}

export { Separator }
