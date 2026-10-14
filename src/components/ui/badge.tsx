import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// A badge written by hand in shadcn's style, trimmed to what the app uses: three tones, the same as the Status component's (--success, --warning and
// --danger, each pinned for contrast in scripts/theme-contrast.test.mjs). Its words carry the meaning, and it has a border as well as a colour, so
// Windows high contrast, which removes fills, still shows it. It is built to the README's 16px text size, not shadcn's
// 12px, so a call site needs no override.
const badgeVariants = cva('inline-flex min-h-6 w-fit shrink-0 items-center justify-center rounded-4xl border px-2.5 py-0.5 text-base font-medium whitespace-nowrap', {
  variants: {
    variant: {
      success: 'border-success text-success',
      warning: 'border-warning text-warning',
      danger: 'border-danger text-danger',
    },
  },
})

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & { variant: NonNullable<VariantProps<typeof badgeVariants>['variant']> }) {
  return <span data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
