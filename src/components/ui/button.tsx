import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// shadcn/ui Button, trimmed to what the app uses. Focus is a solid 2px outline in the ring colour (the stock 50% ring fails 3:1 contrast). It is an outline and not
// the stock box-shadow ring: Windows high contrast removes a shadow, and in the dark theme `dark:border-input` beat the focus border. (It is not `outline-none`
// either: that sets the outline style to none for every `focus-visible:outline-*` beside it.) `touch` is the 44px minimum target from the README's Accessibility
// section; `sm` and `icon` are the compact controls of the header, 32px with a mouse and 44px on a touch screen.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        ghost: 'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        // Looks like the app's Input and Select, for a button that opens a choice of a value (DatePicker): the same border and fill, in both themes.
        field: 'justify-between border-input bg-background text-start font-normal whitespace-normal hover:bg-muted aria-expanded:bg-muted',
      },
      size: {
        default: 'h-8 gap-1.5 px-2.5',
        sm: 'h-8 gap-1.5 px-2.5 pointer-coarse:min-h-11',
        icon: 'size-8 pointer-coarse:size-11',
        // 44px target, and body-size (16px) text since it is for people who find small controls hard.
        touch: 'min-h-11 min-w-11 gap-1.5 px-4 text-base',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
