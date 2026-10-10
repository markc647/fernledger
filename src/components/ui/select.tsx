import * as React from 'react'
import { cn } from '@/lib/utils'

// A native select, styled like Input: the same solid border and focus ring, and the 44px minimum target. The browser's own
// control keeps the keyboard, screen reader and phone behaviour people already know.
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn('block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring', className)}
      {...props}
    />
  )
}

export { Select }
