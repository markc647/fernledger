import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui Input. Border and focus ring are solid for contrast, and the height is the 44px minimum target.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'block min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50 file:me-3 file:border-0 file:bg-transparent file:font-medium',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
